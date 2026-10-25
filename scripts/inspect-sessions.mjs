import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

const endpoint = await Service.discover();
const client = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint),
});

const listed = await client.session.list();
const recent = listed.data
  .filter((s) => (s.time?.updated ?? 0) > Date.now() - 24 * 3600 * 1000)
  .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
  .slice(0, 6);

for (const s of recent) {
  let diffCount = -1;
  let diffSample = '';
  try {
    const diff = await client.session.diff({ sessionID: s.id });
    diffCount = diff.length;
    diffSample = diff[0]?.file ?? '';
  } catch (e) {
    diffSample = `ERR ${e?.message ?? e}`;
  }
  let ctx = null;
  try {
    const context = await client.session.context({ sessionID: s.id });
    const last = context[context.length - 1];
    ctx = {
      count: context.length,
      lastKeys: last ? Object.keys(last) : [],
      lastRole: last?.role ?? last?.type ?? null,
      sample: JSON.stringify(last).slice(0, 500),
    };
  } catch (e) {
    ctx = { error: e?.message ?? String(e) };
  }
  console.log('---');
  console.log(s.id, '|', s.title, '|', diffCount, 'files |', diffSample);
  console.log(JSON.stringify(ctx, null, 2));
}
