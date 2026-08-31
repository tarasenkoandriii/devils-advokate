// Пункт 87 — `sherpa-onnx-wasm` не является зависимостью пакета: модуль
// подключается динамическим import() с webpackIgnore и честно даёт null,
// если не установлен (см. lib/voice-embedding.ts). Без этой декларации
// TypeScript (TS2307) ломает `next build` ещё до попытки загрузки —
// найдено аудитом. API объявлен как any: реальная форма WASM-версии не
// подтверждена (см. комментарий в шапке voice-embedding.ts).
declare module 'sherpa-onnx-wasm' {
  const sherpaOnnx: any;
  export = sherpaOnnx;
}
