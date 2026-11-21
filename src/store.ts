import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { BikeCase, Listing, Score, Verdict } from './domain.ts';
import { scoreListing } from './score.ts';

export const fingerprint = (bike: BikeCase) => {
  const {fetchedAt, ...attributes} = bike;
  return createHash('sha256').update(JSON.stringify(attributes)).digest('hex');
};
const now = () => new Date().toISOString();
const encode = JSON.stringify;
export type Observation = {id:number; runId:number; caseId:string; caseFingerprint:string;
  caseSnapshot:BikeCase;
  candidateKey:string; listing:Listing; score:Score; capturedAt:string;
  verdict:Verdict|null; reviewer:string|null; notes:string|null; reviewedAt:string|null};

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path,0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        source TEXT NOT NULL,query TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY,run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,case_fingerprint TEXT NOT NULL,
        candidate_key TEXT NOT NULL,case_snapshot TEXT NOT NULL,listing TEXT NOT NULL,score TEXT NOT NULL,captured_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observation_case ON observations(case_id,candidate_key,id);
      CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        verdict TEXT NOT NULL CHECK(verdict IN ('match','not_match','unsure')),reviewer TEXT NOT NULL,notes TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_sessions(id INTEGER PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        method TEXT NOT NULL CHECK(method IN ('assisted','manual')),minutes REAL NOT NULL CHECK(minutes>0),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY,observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        state TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,event TEXT NOT NULL,entity TEXT NOT NULL,created_at TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() {this.db.close();}
  transaction<T>(fn:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=fn();this.db.exec('COMMIT');return result;}
    catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  audit(event:string,entity:string) {
    this.db.prepare('INSERT INTO audit(event,entity,created_at) VALUES(?,?,?)').run(event,entity,now());
  }
  putCase(bike:BikeCase) {
    this.transaction(()=>{
      this.db.prepare(`INSERT INTO cases VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
        .run(bike.id,encode(bike),now());
      this.audit('case_upsert',bike.id);
    });
  }
  getCase(id:string):BikeCase {
    const row=this.db.prepare('SELECT data FROM cases WHERE id=?').get(id) as any;
    if(!row) throw new Error(`Case not found: ${id}`);
    return JSON.parse(row.data);
  }
  cases():BikeCase[] {return this.db.prepare('SELECT data FROM cases ORDER BY id').all().map((r:any)=>JSON.parse(r.data));}
  openCase(id:string) {
    const bike=this.getCase(id);
    if(bike.status!=='open') throw new Error('Case is closed');
    return bike;
  }
  startRun(caseId:string,source:string,query:string):number {
    this.openCase(caseId);
    return this.transaction(()=>{
      const id=Number(this.db.prepare('INSERT INTO runs(case_id,source,query,started_at,status) VALUES(?,?,?,?,?)')
        .run(caseId,source,query,now(),'running').lastInsertRowid);
      this.audit('search_started',String(id));return id;
    });
  }
  finishRun(runId:number,bike:BikeCase,listings:Listing[]):number[] {
    return this.transaction(()=>{
      const run=this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as any;
      if(!run || run.status!=='running' || run.case_id!==bike.id) throw new Error('Invalid active run');
      const current=this.openCase(bike.id);
      if(fingerprint(current)!==fingerprint(bike)) throw new Error('Case changed during search; rerun');
      const seen=new Set<string>();const ids:number[]=[];
      for(const listing of listings) {
        const key=createHash('sha256').update(`${bike.id}\n${listing.source}\n${listing.sourceId}`).digest('hex');
        if(seen.has(key)) continue;seen.add(key);
        const id=Number(this.db.prepare(`INSERT INTO observations(run_id,case_id,case_fingerprint,candidate_key,case_snapshot,listing,score,captured_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(runId,bike.id,fingerprint(bike),key,encode(bike),encode(listing),encode(scoreListing(bike,listing)),listing.capturedAt).lastInsertRowid);
        ids.push(id);
      }
      this.db.prepare('UPDATE runs SET status=?,finished_at=? WHERE id=?').run('completed',now(),runId);
      this.audit('search_completed',String(runId));return ids;
    });
  }
  failRun(id:number) {
    this.db.prepare('UPDATE runs SET status=?,finished_at=?,error=? WHERE id=?').run('failed',now(),'Source request failed; see terminal for sanitized reason',id);
    this.audit('search_failed',String(id));
  }
  observations(caseId?:string,latest=true):Observation[] {
    const rows=this.db.prepare(`SELECT o.*,r.verdict,r.reviewer,r.notes,r.created_at AS reviewed_at
      FROM observations o LEFT JOIN reviews r ON r.id=(SELECT MAX(id) FROM reviews WHERE observation_id=o.id)
      WHERE (? IS NULL OR o.case_id=?) ${latest ? 'AND o.id=(SELECT MAX(o2.id) FROM observations o2 WHERE o2.candidate_key=o.candidate_key)' : ''}
      ORDER BY json_extract(o.score,'$.total') DESC,o.id DESC`).all(caseId??null,caseId??null) as any[];
    return rows.map(r=>({id:r.id,runId:r.run_id,caseId:r.case_id,caseFingerprint:r.case_fingerprint,
      candidateKey:r.candidate_key,listing:JSON.parse(r.listing),score:JSON.parse(r.score),capturedAt:r.captured_at,
      caseSnapshot:JSON.parse(r.case_snapshot),
      verdict:r.verdict,reviewer:r.reviewer,notes:r.notes,reviewedAt:r.reviewed_at}));
  }
  observation(id:number):Observation {
    const result=this.observations(undefined,false).find(o=>o.id===id);
    if(!result) throw new Error(`Observation not found: ${id}`);return result;
  }
  current(id:number):{observation:Observation;bike:BikeCase} {
    const observation=this.observation(id);const bike=this.openCase(observation.caseId);
    if(observation.caseFingerprint!==fingerprint(bike)) throw new Error('Case attributes changed; search again before review or notification');
    if(!this.observations(bike.id).some(o=>o.id===id)) throw new Error('A newer listing snapshot exists; review that snapshot');
    return {observation,bike};
  }
  review(id:number,verdict:Verdict,reviewer:string,notes:string) {
    if(!['match','not_match','unsure'].includes(verdict)) throw new Error('Verdict must be match, not_match, or unsure');
    if(!reviewer.trim() || !notes.trim()) throw new Error('Reviewer and evidence notes are required');
    this.transaction(()=>{
      this.current(id);
      this.db.prepare('INSERT INTO reviews(observation_id,verdict,reviewer,notes,created_at) VALUES(?,?,?,?,?)')
        .run(id,verdict,reviewer.trim().slice(0,100),notes.trim().slice(0,5000),now());
      this.audit(`verdict_${verdict}`,String(id));
    });
  }
  time(caseId:string,method:string,minutes:number) {
    this.getCase(caseId);
    if(!['manual','assisted'].includes(method) || !Number.isFinite(minutes) || minutes<=0 || minutes>1440) throw new Error('Use manual/assisted and minutes >0 and <=1440');
    this.db.prepare('INSERT INTO work_sessions(case_id,method,minutes,created_at) VALUES(?,?,?,?)').run(caseId,method,minutes,now());
    this.audit('time_recorded',caseId);
  }
  metrics(caseId?:string) {
    const selected=this.cases().filter(b=>(!caseId||b.id===caseId)&&!b.staged);
    const ids=new Set(selected.map(b=>b.id));
    const candidates=this.observations(caseId).filter(o=>ids.has(o.caseId)&&!o.listing.testData);
    const current=candidates.filter(o=>o.caseFingerprint===fingerprint(this.getCase(o.caseId)));
    const matches=current.filter(o=>o.verdict==='match').length;
    const rejected=current.filter(o=>o.verdict==='not_match').length;
    const sessions=this.db.prepare('SELECT * FROM work_sessions').all() as any[];
    const perCase=selected.map(b=>{
      const sum=(method:string)=>{const rows=sessions.filter(s=>s.case_id===b.id&&s.method===method);return rows.length ? rows.reduce((n,s)=>n+s.minutes,0) : null;};
      const assisted=sum('assisted'),manual=sum('manual');
      return {caseId:b.id,candidates:candidates.filter(o=>o.caseId===b.id).length,assistedMinutes:assisted,manualMinutes:manual,
        minutesSaved:assisted!==null&&manual!==null ? manual-assisted : null};
    });
    return {population:'real cases only; latest listing snapshot and latest verdict; staged data excluded',
      cases:selected.length,candidates:candidates.length,candidatesPerCase:selected.length ? candidates.length/selected.length : null,
      matches,rejected,unsure:current.filter(o=>o.verdict==='unsure').length,
      unreviewed:current.filter(o=>!o.verdict).length,stale:candidates.length-current.length,
      reviewedPrecision:matches+rejected ? matches/(matches+rejected) : null,
      reviewedRejectionFraction:matches+rejected ? rejected/(matches+rejected) : null,
      falsePositiveRate:null,missRate:null,
      limitation:'Verdicts are human judgments, not confirmed recovery. Rejection fraction is NOT population FPR. FPR and miss rate require labeled benchmark negatives/positives.',
      perCase};
  }
  purge(days:number,asOf=new Date()):{cases:number;runs:number} {
    if(!Number.isInteger(days)||days<1||days>365) throw new Error('Retention must be 1..365 days');
    const cutoff=new Date(asOf.getTime()-days*86400000).toISOString();
    const result=this.transaction(()=>{
      const cases=Number(this.db.prepare('DELETE FROM cases WHERE updated_at<?').run(cutoff).changes);
      const runs=Number(this.db.prepare('DELETE FROM runs WHERE started_at<?').run(cutoff).changes);
      this.db.prepare('DELETE FROM work_sessions WHERE created_at<?').run(cutoff);
      this.db.prepare('DELETE FROM audit WHERE created_at<?').run(cutoff);
      this.audit('retention_purge',`${cases} cases; ${runs} runs`);return {cases,runs};
    });
    this.db.exec('VACUUM');return result;
  }
}
