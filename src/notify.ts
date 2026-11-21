import type { Store } from './store.ts';
import { BikeIndex } from './adapters/bikeindex.ts';
import { requestJson } from './http.ts';
import { fingerprint } from './store.ts';

export function notificationDraft(store:Store,id:number) {
  const {observation:o,bike}=store.current(id);
  if(o.verdict!=='match') throw new Error('Notification requires a current human match verdict');
  if(bike.staged || !bike.bikeIndexId) throw new Error('Staged cases cannot notify Bike Index');
  if(o.listing.source==='staged'||o.listing.testData||o.listing.environment==='sandbox') throw new Error('Staged or sandbox listing cannot notify Bike Index');
  return {bikeIndexId:bike.bikeIndexId,observationId:id,
    reportUrl:`https://bikeindex.org/bikes/${bike.bikeIndexId}`,
    message:`Possible bicycle recovery lead, reviewed by a human. This is not a finding about any seller.\nListing: ${o.listing.url}\nCaptured: ${o.capturedAt}\nEvidence: ${o.notes}\nPlease verify independently through Bike Index.`};
}

export async function sendNotification(store:Store,id:number,token:string,fetcher:typeof fetch=fetch) {
  if(!token) throw new Error('BIKEINDEX_TOKEN with read_user scope and application approval required');
  const draft=notificationDraft(store,id);
  // Check authoritative current status immediately before sending.
  const current=await new BikeIndex(token,fetcher).get(draft.bikeIndexId);
  if(current.status!=='open') {store.putCase(current);throw new Error('Bike Index case is no longer stolen; notification blocked');}
  if(fingerprint(current)!==fingerprint(store.getCase(`bikeindex:${draft.bikeIndexId}`))) {
    store.putCase(current);throw new Error('Authoritative case attributes changed; search and review again');
  }
  notificationDraft(store,id); // Recheck after asynchronous request.
  store.transaction(()=>{
    const existing=store.db.prepare(`SELECT n.id FROM notifications n JOIN observations o ON n.observation_id=o.id
      WHERE o.candidate_key=?`).get(store.observation(id).candidateKey);
    if(existing) throw new Error('Notification already attempted; reconcile outcome manually instead of retrying');
    store.db.prepare('INSERT INTO notifications(observation_id,state,created_at) VALUES(?,?,?)').run(id,'pending',new Date().toISOString());
    store.audit('notification_attempt',String(id));
  });
  try {
    await requestJson(`https://bikeindex.org/api/v3/bikes/${draft.bikeIndexId}/send_stolen_notification`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({message:draft.message})
    },fetcher);
    store.db.prepare('UPDATE notifications SET state=? WHERE observation_id=?').run('sent',id);
    store.audit('notification_sent',String(id));return {sent:true,via:'Bike Index',observationId:id};
  } catch(e) {
    // A timeout can happen after delivery: never automatically retry.
    store.db.prepare('UPDATE notifications SET state=? WHERE observation_id=?').run('unknown_or_failed',id);
    store.audit('notification_outcome_uncertain',String(id));throw e;
  }
}
