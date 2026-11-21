import {readFileSync} from 'node:fs';
import {Store} from '../src/store.ts';
import {parseListing} from '../src/domain.ts';
import {benchmark} from '../src/benchmark.ts';
import {notificationDraft} from '../src/notify.ts';

const fixture=JSON.parse(readFileSync(new URL('../fixtures/benchmark.json',import.meta.url),'utf8'));
const store=new Store(':memory:');
try {
  store.putCase(fixture.bike);
  const run=store.startRun(fixture.bike.id,'staged','Trek FX 3 bicycle');
  const ids=store.finishRun(run,fixture.bike,fixture.items.map((i:any)=>parseListing(i.listing,'staged')));
  store.review(ids[0],'match','DEMO SCRIPT, not a human','Synthetic example verdict to exercise the gate');
  let gate='';try{notificationDraft(store,ids[0]);}catch(e){gate=(e as Error).message;}
  console.log(JSON.stringify({mode:'synthetic, no network, in-memory database',
    queue:store.observations(),notificationGate:gate,benchmark:benchmark(fixture),realMetrics:store.metrics()},null,2));
} finally {store.close();}
