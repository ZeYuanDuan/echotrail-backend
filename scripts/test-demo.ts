const baseUrl = process.env.API_BASE_URL?.replace(/\/$/, '') || 'http://127.0.0.1:8080';
const iterations = Number(process.env.ITERATIONS || 5);
const requestInterval = Number(process.env.REQUEST_INTERVAL_MS || 5_000);
const script = [
  '這週我們那個卡了快兩個月的功能終於上線了，使用數據比預期好很多，合作團隊主動跟我說回饋變好了。',
  '我真的很有成就感，尤其這次我堅持先花時間跟實際使用者做幾場訪談才動手設計，而不是直接照對方提的需求硬做，雖然一開始被念說太慢、拖進度。',
  '我覺得這次能成功，是因為我沒有把對方提的需求直接當成答案，而是先搞懂真正卡住的地方在哪，我一直覺得自己擅長的就是把模糊的抱怨拆解成具體可以解決的問題，這次證明這個方法是對的，接下來我也想試著把這套方法用在更早期的規劃階段。',
];

type Message = { role: 'user' | 'model'; text: string };
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const post = async (path: string, messages: Message[]) => {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path} ${response.status}: ${String(body.error)}`);
  return { body, duration: Math.round(performance.now() - startedAt) };
};

const results: Array<{ iteration: number; duration: number; signals: number }> = [];
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const messages: Message[] = [];
  let duration = 0;
  for (const text of script) {
    if (messages.length) await wait(requestInterval);
    messages.push({ role: 'user', text });
    const chat = await post('/api/llm/chat', messages);
    duration += chat.duration;
    if (typeof chat.body.text !== 'string') throw new Error('Chat response is missing text');
    messages.push({ role: 'model', text: chat.body.text });
  }
  await wait(requestInterval);
  const insight = await post('/api/llm/insight', messages);
  duration += insight.duration;
  const signals = Array.isArray(insight.body.signals) ? insight.body.signals.length : 0;
  results.push({ iteration, duration, signals });
  console.log(`run ${iteration}/${iterations}: ok, ${duration}ms, ${signals} grounded signals`);
  if (iteration < iterations) await wait(requestInterval);
}

const average = Math.round(results.reduce((sum, result) => sum + result.duration, 0) / results.length);
console.log(`summary: ${results.length}/${iterations} passed, average ${average}ms`);
