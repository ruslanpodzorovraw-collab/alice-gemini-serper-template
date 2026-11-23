import { createHash } from "node:crypto";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_STORED_STATE_BYTES = 900;
const MEMORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MEMORY_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_PERSISTED_MESSAGES = 500;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_MESSAGE_CHARS = 700;
const MEMORY_STORE_TIMEOUT_MS = 350;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4200;
const SERPER_TIMEOUT_MS = 600;
const GEMINI_TIMEOUT_MS = 3200;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Учитывай сохранённый контекст предыдущих разговоров, если он относится к вопросу.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = [], userStateUpdate) {
  const result = {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history: safeHistory(history) }
  };

  if (userStateUpdate !== undefined) result.user_state_update = userStateUpdate;
  return result;
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  const messages = history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));

  while (messages.length && Buffer.byteLength(JSON.stringify({ history: messages }), "utf8") > MAX_STORED_STATE_BYTES) {
    if (messages.length > 4) {
      messages.shift();
      continue;
    }

    const largestIndex = messages.reduce((largest, item, index, items) => (
      Buffer.byteLength(item.text, "utf8") > Buffer.byteLength(items[largest].text, "utf8") ? index : largest
    ), 0);
    const message = messages[largestIndex];
    const textBytes = Buffer.byteLength(message.text, "utf8");
    const overflowBytes = Buffer.byteLength(JSON.stringify({ history: messages }), "utf8") - MAX_STORED_STATE_BYTES;
    if (textBytes === 0) {
      messages.shift();
      continue;
    }

    message.text = truncateUtf8(message.text, Math.max(0, textBytes - Math.max(overflowBytes, 32)));
  }

  return messages;
}

function truncateUtf8(value, maxBytes) {
  let result = "";
  let size = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (size + characterBytes > maxBytes) break;
    result += character;
    size += characterBytes;
  }
  return result;
}

function historyFromState(body) {
  const sessionHistory = safeHistory(body?.state?.session?.history);
  if (sessionHistory.length) return sessionHistory;
  return safeHistory(body?.state?.user?.history);
}

function hasAuthorizedYandexUser(body) {
  return typeof body?.session?.user?.user_id === "string" && body.session.user.user_id.length > 0;
}

function persistentUserId(body) {
  const sessionUserId = body?.session?.user_id;
  if (typeof sessionUserId === "string" && sessionUserId.length > 0) return sessionUserId;
  const linkedUserId = body?.session?.user?.user_id;
  return typeof linkedUserId === "string" && linkedUserId.length > 0 ? linkedUserId : null;
}

function userStateUpdate(body, history) {
  return hasAuthorizedYandexUser(body) ? { history: safeHistory(history) } : undefined;
}

function hasPersistentMemoryConfig() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function persistentMemoryKey(userId) {
  const digest = createHash("sha256").update(userId, "utf8").digest("hex");
  return `alice:memory:${digest}`;
}

async function redisCommand(command, timeoutMs) {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("MEMORY_STORE_NOT_CONFIGURED");

  const { response, data } = await fetchJson(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command)
    },
    timeoutMs
  );

  if (!response.ok || data?.error) throw new Error("MEMORY_STORE_REQUEST_FAILED");
  return data?.result;
}

function normalizePersistentMessages(value, now = Date.now()) {
  if (!Array.isArray(value)) return [];
  const cutoff = now - MEMORY_RETENTION_MS;
  return value
    .filter(item => item
      && (item.role === "user" || item.role === "model")
      && typeof item.text === "string"
      && Number.isFinite(item.createdAt)
      && item.createdAt >= cutoff
      && item.createdAt <= now + 60_000)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS),
      createdAt: item.createdAt
    }))
    .slice(-MAX_PERSISTED_MESSAGES);
}

async function loadPersistentMemory(userId, timeoutMs) {
  const key = persistentMemoryKey(userId);
  const raw = await redisCommand(["GET", key], timeoutMs);
  if (typeof raw !== "string" || !raw) return { key, messages: [] };

  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    console.warn("Persistent memory contained invalid JSON; starting with an empty history.");
    return { key, messages: [] };
  }

  const previousMessages = Array.isArray(stored?.messages) ? stored.messages : [];
  const messages = normalizePersistentMessages(previousMessages);
  const removedExpiredMessages = messages.length !== previousMessages.length;
  if (removedExpiredMessages) {
    try {
      await savePersistentMemory(key, messages, timeoutMs);
    } catch {
      console.warn("Expired conversation turns could not be purged from the external store.");
    }
  }
  return { key, messages };
}

async function savePersistentMemory(key, messages, timeoutMs) {
  const currentMessages = normalizePersistentMessages(messages);
  if (!currentMessages.length) return redisCommand(["DEL", key], timeoutMs);
  return redisCommand([
    "SET",
    key,
    JSON.stringify({ messages: currentMessages }),
    "EX",
    String(MEMORY_RETENTION_SECONDS)
  ], timeoutMs);
}

function memoryTerms(text) {
  const stopWords = new Set([
    "this", "that", "what", "when", "where", "which", "with", "from", "have", "were", "your",
    "когда", "какой", "какая", "какие", "какое", "чтобы", "почему", "зачем", "который", "которая",
    "которые", "этот", "такая", "такой", "такие", "меня", "тебе", "тебя", "твой", "твоя", "твои",
    "наш", "наша", "наши", "что", "есть", "был", "была", "были", "будет", "буду", "они", "она"
  ]);
  const words = String(text).toLocaleLowerCase("ru-RU").match(/[a-zа-яё0-9]{4,}/g) || [];
  return new Set(words
    .filter(word => !stopWords.has(word))
    .map(word => word.length > 6 ? word.slice(0, 6) : word));
}

function selectRelevantHistory(messages, query) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const recentCount = Math.min(4, messages.length);
  const recentStart = messages.length - recentCount;
  const recent = messages.slice(recentStart);
  const queryTerms = memoryTerms(query);
  const older = messages.slice(0, recentStart);
  const olderTurns = [];
  for (let index = 0; index < older.length; index += 1) {
    const turn = [older[index]];
    if (older[index].role === "user" && older[index + 1]?.role === "model") {
      turn.push(older[index + 1]);
      index += 1;
    }
    olderTurns.push({ turn, index: index - turn.length + 1 });
  }

  const relevantTurns = olderTurns
    .map(({ turn, index }) => {
      const terms = memoryTerms(turn.map(message => message.text).join(" "));
      let score = 0;
      for (const term of queryTerms) {
        if (terms.has(term)) score += 1;
      }
      return { turn, index, score };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .reduce((selected, item) => {
      const selectedCount = selected.reduce((count, candidate) => count + candidate.turn.length, 0);
      if (selectedCount + item.turn.length <= MAX_CONTEXT_MESSAGES - recentCount) selected.push(item);
      return selected;
    }, []);
  const relevant = relevantTurns.flatMap(item => item.turn);

  return [...relevant, ...recent]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_CONTEXT_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_CONTEXT_MESSAGE_CHARS)
    }));
}

function isForgetMemoryRequest(text) {
  return /(?:забудь|удали|очисти|сбрось).*(?:истори|памят|диалог|разговор|всё|все|что мы обсуждали)|(?:forget|clear|delete).*(?:memory|history|conversation)/i.test(text);
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  let oldHistory = historyFromState(body);
  let persistentMemory = null;
  const memoryUserId = persistentUserId(body);

  if (isForgetMemoryRequest(text)) {
    let memoryDeleted = true;
    if (memoryUserId && hasPersistentMemoryConfig()) {
      try {
        await redisCommand(
          ["DEL", persistentMemoryKey(memoryUserId)],
          Math.min(MEMORY_STORE_TIMEOUT_MS, Math.max(100, remainingMs() - 150))
        );
      } catch {
        memoryDeleted = false;
        console.warn("Persistent memory could not be deleted from the external store.");
      }
    }

    const clearUserState = hasAuthorizedYandexUser(body) ? { history: null } : undefined;
    return res.status(200).json(aliceResponse(
      memoryDeleted
        ? "Хорошо, я забыла сохранённую историю наших разговоров."
        : "Не получилось полностью очистить историю. Попробуй ещё раз чуть позже.",
      false,
      [],
      clearUserState
    ));
  }

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory,
      userStateUpdate(body, oldHistory)
    ));
  }

  if (memoryUserId && hasPersistentMemoryConfig()) {
    try {
      const loadTimeout = Math.min(MEMORY_STORE_TIMEOUT_MS, Math.max(100, remainingMs() - 3500));
      persistentMemory = await loadPersistentMemory(memoryUserId, loadTimeout);
      oldHistory = persistentMemory.messages.length
        ? selectRelevantHistory(persistentMemory.messages, text)
        : historyFromState(body);
    } catch {
      persistentMemory = null;
      console.warn("Persistent memory could not be read; using the short Yandex state instead.");
    }
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 600))
    );

    const history = safeHistory([
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ]);

    if (persistentMemory?.key && remainingMs() >= 200) {
      const now = Date.now();
      const baseMemory = persistentMemory.messages.length
        ? persistentMemory.messages
        : historyFromState(body).map(item => ({ ...item, createdAt: now }));
      const messagesToSave = [
        ...baseMemory,
        { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS), createdAt: now },
        { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS), createdAt: now }
      ].slice(-MAX_PERSISTED_MESSAGES);
      try {
        const writeTimeout = Math.min(MEMORY_STORE_TIMEOUT_MS, remainingMs() - 150);
        await savePersistentMemory(persistentMemory.key, messagesToSave, writeTimeout);
      } catch {
        console.warn("The response was generated, but persistent memory could not be updated.");
      }
    }

    return res.status(200).json(aliceResponse(answer, false, history, userStateUpdate(body, history)));
  } catch (error) {
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(
      errorForUser(safeError),
      false,
      oldHistory,
      userStateUpdate(body, oldHistory)
    ));
  }
}

export {
  aliceResponse,
  fitAliceText,
  historyFromState,
  isForgetMemoryRequest,
  isSearchIntent,
  selectRelevantHistory,
  safeHistory
};
