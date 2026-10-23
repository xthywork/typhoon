const T = Date.UTC(2026, 9, 23), H = 3600000;
const AGENCIES = ['CWA', 'JMA', 'KMA', 'HKO', 'JTWC', 'CMA'];
function fixture(version = 'v1') {
  const sources = Object.fromEntries(AGENCIES.map(k => [k, {status: 'ok', message: 'safe', checked: T, succeeded: T}]));
  function storm(id, delta = 0) {
    const history = [0, 6, 12].map(h => ({time: T+h*H, lat: 20+h/10+delta, lon: 130, w: 30, p: 980, windRadius15ms: 100}));
    const batches = [12, 6, 0].map(h => ({issued: T+h*H, base: T+h*H, points: history.map(p => ({...p, time: p.time+h*H}))}));
    return {id, name: id, historyAgency: 'CWA', active: true, history, batchTimes: batches.map(b => b.issued),
      sources: {CWA: {history, batches, url: 'https://example.invalid'}, JMA: {history, batches, url: 'https://example.invalid'}}};
  }
  return {schemaVersion: 1, version, synced: T, sources, typhoons: [storm('storm-A'), storm('storm-B', 10)]};
}
module.exports={fixture,T,H};
