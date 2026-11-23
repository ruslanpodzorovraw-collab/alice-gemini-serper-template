import test from "node:test";
import assert from "node:assert/strict";
import {
  aliceResponse,
  fitAliceText,
  historyFromState,
  isForgetMemoryRequest,
  isSearchIntent,
  selectRelevantHistory,
  safeHistory
} from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("history stays under the Yandex state storage limit, including Cyrillic and emoji", () => {
  const input = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: "Контекст 🙂 это длинное сообщение. ".repeat(100)
  }));
  const result = safeHistory(input);
  assert.ok(Buffer.byteLength(JSON.stringify({ history: result }), "utf8") <= 1024);
  assert.ok(result.length > 0);
});

test("a new session restores user memory when it has no session history", () => {
  const memory = [{ role: "user", text: "Меня зовут Анна" }];
  assert.deepEqual(historyFromState({ state: { user: { history: memory } } }), memory);
  assert.deepEqual(historyFromState({
    state: {
      session: { history: [{ role: "user", text: "Текущая сессия" }] },
      user: { history: memory }
    }
  }), [{ role: "user", text: "Текущая сессия" }]);
});

test("Alice response can persist and clear user memory", () => {
  const memory = [{ role: "user", text: "Меня зовут Анна" }];
  const response = aliceResponse("Хорошо", false, memory, { history: memory });
  assert.deepEqual(response.user_state_update, { history: memory });

  const cleared = aliceResponse("Забыла", false, [], { history: null });
  assert.deepEqual(cleared.user_state_update, { history: null });
  assert.deepEqual(cleared.session_state.history, []);
});

test("memory deletion requests are recognized without matching ordinary forget requests", () => {
  assert.equal(isForgetMemoryRequest("Забудь наши прошлые диалоги"), true);
  assert.equal(isForgetMemoryRequest("Очисти сохранённую память"), true);
  assert.equal(isForgetMemoryRequest("Забудь всё, что мы обсуждали"), true);
  assert.equal(isForgetMemoryRequest("Забудь рецепт, который мы обсуждали"), false);
  assert.equal(isForgetMemoryRequest("Забудь зонтик"), false);
});

test("long-term memory keeps recent turns and selects older turns related to the question", () => {
  const messages = [
    { role: "user", text: "Я живу в Казани и работаю аналитиком", createdAt: 1_000 },
    { role: "model", text: "Поняла, вы живёте в Казани", createdAt: 1_001 },
    { role: "user", text: "Посоветуй хороший фильм", createdAt: 2_000 },
    { role: "model", text: "Можно посмотреть комедию", createdAt: 2_001 },
    { role: "user", text: "Спасибо", createdAt: 3_000 },
    { role: "model", text: "Пожалуйста", createdAt: 3_001 }
  ];

  assert.deepEqual(selectRelevantHistory(messages, "В каком городе я живу?"), [
    { role: "user", text: "Я живу в Казани и работаю аналитиком" },
    { role: "model", text: "Поняла, вы живёте в Казани" },
    { role: "user", text: "Посоветуй хороший фильм" },
    { role: "model", text: "Можно посмотреть комедию" },
    { role: "user", text: "Спасибо" },
    { role: "model", text: "Пожалуйста" }
  ]);
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

test("Yandex session user memory is sent to Gemini and saved across sessions", async () => {
  const handler = (await import("../api/index.js")).default;
  const previousApiKey = process.env.GEMINI_API_KEY;
  const previousRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-test-token";

  let geminiBody;
  const redisCommands = [];
  const storedMemory = [
    { role: "user", text: "Меня зовут Анна", createdAt: Date.now() - 10_000 },
    { role: "model", text: "Приятно познакомиться, Анна", createdAt: Date.now() - 9_000 }
  ];
  globalThis.fetch = async (url, options) => {
    if (url === "https://redis.test") {
      const command = JSON.parse(options.body);
      redisCommands.push(command);
      return {
        ok: true,
        status: 200,
        async json() {
          return command[0] === "GET"
            ? { result: JSON.stringify({ messages: storedMemory }) }
            : { result: "OK" };
        }
      };
    }

    geminiBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return { candidates: [{ content: { parts: [{ text: "Рада снова вас видеть, Анна." }] } }] };
      }
    };
  };

  let payload;
  const res = {
    status() { return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };

  try {
    await handler({
      method: "POST",
      body: {
        request: { command: "Как меня зовут?" },
        session: { user_id: "yandex-user-1" },
        state: { session: { history: [] } }
      }
    }, res);

    assert.deepEqual(geminiBody.contents[0], {
      role: "user",
      parts: [{ text: "Меня зовут Анна" }]
    });
    assert.deepEqual(redisCommands.map(command => command[0]), ["GET", "SET"]);
    assert.match(redisCommands[0][1], /^alice:memory:[a-f0-9]{64}$/);
    assert.ok(!redisCommands[0][1].includes("yandex-user-1"));
    assert.equal(redisCommands[1][1], redisCommands[0][1]);
    assert.equal(redisCommands[1][3], "EX");
    assert.equal(redisCommands[1][4], String(30 * 24 * 60 * 60));
    const persistedMessages = JSON.parse(redisCommands[1][2]).messages;
    assert.deepEqual(persistedMessages.slice(-2).map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "Как меня зовут?" },
      { role: "model", text: "Рада снова вас видеть, Анна." }
    ]);
    assert.deepEqual(payload.session_state.history.slice(-2), [
      { role: "user", text: "Как меня зовут?" },
      { role: "model", text: "Рада снова вас видеть, Анна." }
    ]);
    assert.equal(payload.user_state_update, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(payload.session_state), "utf8") <= 1024);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousApiKey;
    if (previousRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousRedisUrl;
    if (previousRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousRedisToken;
  }
});

test("authorized user can clear persisted and current-session memory", async () => {
  const handler = (await import("../api/index.js")).default;
  const previousRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const previousRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-test-token";
  let redisCommand;
  globalThis.fetch = async (_url, options) => {
    redisCommand = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { result: 1 }; } };
  };

  let payload;
  const res = {
    status() { return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };

  try {
    await handler({
      method: "POST",
      body: {
        request: { command: "Забудь наши прошлые диалоги" },
        session: {
          user_id: "stable-yandex-user-id",
          user: { user_id: "linked-account-id" }
        },
        state: {
          session: { history: [{ role: "user", text: "Секретный текст" }] },
          user: { history: [{ role: "user", text: "Секретный текст" }] }
        }
      }
    }, res);

    assert.deepEqual(payload.session_state.history, []);
    assert.deepEqual(payload.user_state_update, { history: null });
    assert.match(payload.response.text, /забыла/);
    assert.equal(redisCommand[0], "DEL");
    assert.match(redisCommand[1], /^alice:memory:[a-f0-9]{64}$/);
    assert.ok(!redisCommand[1].includes("yandex-user-1"));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = previousRedisUrl;
    if (previousRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = previousRedisToken;
  }
});
