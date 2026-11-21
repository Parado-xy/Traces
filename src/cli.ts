import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Store, fingerprint } from './store.ts';
import { BikeIndex, normalizeBike } from './adapters/bikeindex.ts';
import { Ebay } from './adapters/ebay.ts';
import { parseListing } from './domain.ts';
import type { Verdict } from './domain.ts';
import { caseQuery } from './score.ts';
import { benchmark } from './benchmark.ts';
import { notificationDraft, sendNotification } from './notify.ts';

if(existsSync('.env')) process.loadEnvFile('.env');
const {values:v,positionals}=parseArgs({allowPositionals:true,options:{
  db:{type:'string'},case:{type:'string'},region:{type:'string'},distance:{type:'string'},limit:{type:'string'},
  file:{type:'string'},id:{type:'string'},source:{type:'string'},verdict:{type:'string'},reviewer:{type:'string'},
  notes:{type:'string'},query:{type:'string'},method:{type:'string'},minutes:{type:'string'},threshold:{type:'string'},
  days:{type:'string'},send:{type:'boolean'},help:{type:'boolean'}
}});
const help=`Traces: bicycle case-led matching MVP (Node 24+)
Commands (all output is JSON; all accept --db PATH):
  init
  ingest --region "Grambling, LA" --distance 100 --limit 3
  refresh --case bikeindex:123
  import-case --file bikeindex-response.json
  cases
  show --case bikeindex:123
  search --case bikeindex:123 --source ebay
  import-listings --case bikeindex:123 --file listings.json --query "actual search terms used"
  queue [--case bikeindex:123]
  review --id 1 --verdict match|not_match|unsure --reviewer Jalla --notes "Evidence checked..."
  time --case bikeindex:123 --method manual|assisted --minutes 6.5
  metrics [--case bikeindex:123]
  benchmark --file fixtures/benchmark.json [--threshold 50]
  notify --id 1                  # local draft only
  notify --id 1 --send           # explicit outward action, requires approved Bike Index app
  audit
  purge [--days 30]
Use npm run demo for an isolated synthetic demonstration. No notification is sent by demo.
Manual imports must contain object information only; omit names, contact details, and seller profiles.
`;
const command=positionals[0];
if(v.help||!command) {console.log(help);process.exit(0);}
const required=(key:keyof typeof v)=>{const value=v[key];if(typeof value!=='string'||!value.trim()) throw new Error(`--${key} is required`);return value;};
const number=(key:keyof typeof v,fallback?:number)=>{
  const n=v[key]===undefined ? fallback : Number(required(key));
  if(n===undefined||!Number.isFinite(n)) throw new Error(`--${key} must be numeric`);return n;
};
const jsonFile=()=>JSON.parse(readFileSync(required('file'),'utf8'));
let store:Store|undefined;
try {
  if(positionals.length>1) throw new Error('Unexpected positional arguments');
  if(command==='benchmark') {console.log(JSON.stringify(benchmark(jsonFile(),number('threshold',50)),null,2));}
  else {
    store=new Store(resolve(v.db||process.env.TRACE_DB||'data/trace-shadow.sqlite'));
    // Retention is enforced whenever the CLI opens a store. No background daemon.
    const days=Number(process.env.RETENTION_DAYS||30);
    store.purge(days);
    let output:unknown;
    switch(command) {
      case 'init':output={initialized:true,schemaVersion:1,retentionDays:days};break;
      case 'ingest':{
        const bikes=await new BikeIndex(process.env.BIKEINDEX_TOKEN).search(v.region||'Grambling, LA',number('distance',100),number('limit',3));
        for(const bike of bikes) store.putCase(bike);
        output={ingested:bikes.length,cases:bikes.map(b=>({id:b.id,make:b.make,model:b.model,stolenLocation:b.stolenLocation}))};break;
      }
      case 'refresh':{
        const bike=store.getCase(required('case'));if(!bike.bikeIndexId) throw new Error('Staged case cannot refresh from Bike Index');
        const current=await new BikeIndex(process.env.BIKEINDEX_TOKEN).get(bike.bikeIndexId);store.putCase(current);output=current;break;
      }
      case 'import-case':{
        const raw=jsonFile();const bike=normalizeBike(raw.bike??raw);store.putCase(bike);output=bike;break;
      }
      case 'cases':output=store.cases();break;
      case 'show':output=store.getCase(required('case'));break;
      case 'search':{
        if(required('source')!=='ebay') throw new Error('Only eBay automation is implemented; use manual object-only imports for other sources');
        const bike=store.openCase(required('case'));const environment=process.env.EBAY_ENV||'sandbox';
        if(environment!=='sandbox'&&environment!=='production') throw new Error('EBAY_ENV must be sandbox or production');
        const adapter=new Ebay({clientId:process.env.EBAY_CLIENT_ID||'',clientSecret:process.env.EBAY_CLIENT_SECRET||'',
          environment,productionApproved:process.env.EBAY_PRODUCTION_APPROVED==='true'});
        const run=store.startRun(bike.id,`ebay:${environment}`,caseQuery(bike));
        try {const result=await adapter.search(bike);output={runId:run,observations:store.finishRun(run,bike,result.listings)};}
        catch(e) {store.failRun(run);throw e;}break;
      }
      case 'import-listings':{
        const bike=store.openCase(required('case'));const raw=jsonFile();
        if(!Array.isArray(raw)||raw.length>100) throw new Error('Expected an array of at most 100 case-specific listings');
        const listings=raw.map(x=>parseListing(x,bike.staged?'staged':'manual'));
        const run=store.startRun(bike.id,'manual',required('query').slice(0,500));
        try {output={runId:run,observations:store.finishRun(run,bike,listings)};}
        catch(e) {store.failRun(run);throw e;}break;
      }
      case 'queue':{
        const activeStore=store;
        output=store.observations(v.case).map(o=>({...o,
          caseStatus:activeStore.getCase(o.caseId).status,
          caseChanged:o.caseFingerprint!==fingerprint(activeStore.getCase(o.caseId)),leadOnly:true}));break;
      }
      case 'review':store.review(number('id'),required('verdict') as Verdict,required('reviewer'),required('notes'));output={recorded:true,observationId:number('id')};break;
      case 'time':store.time(required('case'),required('method'),number('minutes'));output={recorded:true};break;
      case 'metrics':if(v.case) store.getCase(v.case);output=store.metrics(v.case);break;
      case 'notify':{
        if(v.send) {
          if(process.env.BIKEINDEX_NOTIFY_APPROVED!=='true') throw new Error('Sending disabled: approved Bike Index application or an authorized own-bike test required; set BIKEINDEX_NOTIFY_APPROVED=true only after that setup');
          output=await sendNotification(store,number('id'),process.env.BIKEINDEX_TOKEN||'');
        } else output={sent:false,draft:notificationDraft(store,number('id'))};
        break;
      }
      case 'audit':output=store.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all();break;
      case 'purge':output=store.purge(number('days',days));break;
      default:throw new Error(`Unknown command: ${command}. Use --help`);
    }
    console.log(JSON.stringify(output,null,2));
  }
} catch(error) {
  console.error(JSON.stringify({error:error instanceof Error?error.message:'Unexpected failure'}));process.exitCode=1;
} finally {store?.close();}
