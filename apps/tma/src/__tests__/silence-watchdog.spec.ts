// 2026-09-02 — авто-стоп голосового ввода после тишины.
import { rmsOfByteTimeDomain, startSilenceWatchdog } from '../lib/silence-watchdog';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL: ${message}\n  ожидалось: ${JSON.stringify(expected)}\n  получено:  ${JSON.stringify(actual)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Фейковый AnalyserNode: отдаёт байты вокруг 128 с заданной амплитудой. */
function fakeAnalyser(amplitudeRef: { value: number }): AnalyserNode {
  return {
    fftSize: 64,
    getByteTimeDomainData(target: Uint8Array) {
      for (let i = 0; i < target.length; i++) target[i] = 128 + Math.round((i % 2 === 0 ? 1 : -1) * amplitudeRef.value * 128);
    },
  } as unknown as AnalyserNode;
}

const scenarios: Array<[string, () => Promise<void>]> = [
  ['RMS: тишина ≈ 0, речь заметно выше порога 0,02', async () => {
    assertEqual(rmsOfByteTimeDomain(new Uint8Array(16).fill(128)), 0, 'ровная линия — ноль');
    const loud = new Uint8Array(16); for (let i = 0; i < 16; i++) loud[i] = i % 2 ? 160 : 96;
    assertEqual(rmsOfByteTimeDomain(loud) > 0.2, true, 'амплитуда 32/128 — явно речь');
  }],
  ['КЛЮЧЕВОЙ: тишина дольше порога → onSilence ровно один раз', async () => {
    const amp = { value: 0 };
    let fired = 0;
    const handle = startSilenceWatchdog(fakeAnalyser(amp), () => { fired++; }, { silenceMs: 120, pollMs: 20 });
    await sleep(260);
    handle.stop();
    assertEqual(fired, 1, 'сработал один раз');
  }],
  ['речь (RMS выше порога) сбрасывает таймер — стопа нет', async () => {
    const amp = { value: 0.1 };
    let fired = 0;
    const handle = startSilenceWatchdog(fakeAnalyser(amp), () => { fired++; }, { silenceMs: 120, pollMs: 20 });
    await sleep(260);
    handle.stop();
    assertEqual(fired, 0, 'пока говорят — не останавливаем');
  }],
  ['текст от провайдера (touch) считается речью даже при тихом сигнале', async () => {
    const amp = { value: 0 };
    let fired = 0;
    const handle = startSilenceWatchdog(fakeAnalyser(amp), () => { fired++; }, { silenceMs: 120, pollMs: 20 });
    const touching = setInterval(() => handle.touch(), 40);
    await sleep(260);
    clearInterval(touching);
    handle.stop();
    assertEqual(fired, 0, 'распознанный текст — не тишина');
  }],
  ['без AnalyserNode работает только по touch: молчание провайдера → стоп', async () => {
    let fired = 0;
    const handle = startSilenceWatchdog(null, () => { fired++; }, { silenceMs: 60, pollMs: 10 });
    await sleep(150);
    handle.stop();
    assertEqual(fired, 1, 'таймер без акустики');
  }],
  ['stop() до срабатывания — onSilence не вызывается', async () => {
    let fired = 0;
    const handle = startSilenceWatchdog(null, () => { fired++; }, { silenceMs: 60, pollMs: 10 });
    handle.stop();
    await sleep(120);
    assertEqual(fired, 0, 'остановлено вручную раньше');
  }],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of scenarios) {
    try { await fn(); console.log(`✓ ${name}`); }
    catch (err) { failed++; console.log(`✗ ${name}\n${(err as Error).message}`); }
  }
  console.log(`silence-watchdog: ${scenarios.length - failed}/${scenarios.length} passed`);
  if (failed > 0) process.exit(1);
})();
