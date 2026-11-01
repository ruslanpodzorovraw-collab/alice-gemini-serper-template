const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;

// Общий бюджет времени для ответа Алисе (лимит Яндекса — 4.5 с)
const TOTAL_RESPONSE_BUDGET_MS = 4100;
// Увеличенный таймаут поиска (Serper отвечает за 600–1500 мс)
const SERPER_TIMEOUT_MS = 1600;
// Таймаут для генерации Gemini (1-3 коротких предложения формируются за 600-1200 мс)
const GEMINI_TIMEOUT_MS = 2300;

function getSystemPrompt() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long"
  });
  return [
    "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
    `Сегодняшняя дата: ${dateStr}. Текущий год — ${now.getFullYear()} год.`,
    "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать вслух.",
    "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
    "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
    "Если не знаешь ответа, честно скажи об этом."
  ].join(" ");
}

function aliceResponse(text, endSession = false, history = []) {
  const clean = fitAliceText(text);
  return {
    version: "1.0",
    response: {
      text: clean,
      tts: clean,
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  let text = String(value ?? "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/https?:\/\/\S+/g, "")
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
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс|биткоин|доллар|найди|поищи|погугли|загугли|актуальн|сколько стоит|свежие данные|в мире|в россии|что случилось|кто победил|кто выиграл/i.test(text);
}

function cleanSearchQuery(text) {
  const cleaned = text
    .replace(/^(?:алиса\s*,?\s*)?(?:поищи|найди|посмотри|узнай|проверь|скажи|расскажи)?\s*(?:в\s+интернете|в\s+гугле|в\s+сети)?\s*/i, "")
    .replace(/^(?:пожалуйста|сразу)\s*,?\s*/i, "")
    .trim();
  return cleaned || text;
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
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
  const key = process.env.SERPER_API_KEY || process.env.SEPER_API_KEY;
  if (!key || timeoutMs < 200) return "";

  try {
    const cleanQ = cleanSearchQuery(query);
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: cleanQ, gl: "ru", hl: "ru", num: 4 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = [];
    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.push(`Краткий ответ поисковика: ${String(answerBox).slice(0, 300)}`);

    if (Array.isArray(data.organic)) {
      for (const item of data.organic.slice(0, 3)) {
        const title = String(item.title || "").slice(0, 160);
        const snippet = String(item.snippet || "").slice(0, 300);
        items.push(`${title}: ${snippet}`);
      }
    }

    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search:", error?.message);
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
    ? `${text}\n\n[Актуальные факты и результаты поиска в интернете]:\n${searchContext}\nИспользуй эти факты для прямого ответа на русском языке. Не упоминай поисковики, сайты или ссылки.`
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
        systemInstruction: { parts: [{ text: getSystemPrompt() }] },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 250
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
    .map(part => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
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
      return "Превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ вовремя. Попробуйте повторить вопрос.";
    default:
      return "Не удалось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
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
  const oldHistory = safeHistory(body?.state?.session?.history);

  const exitPhrases = /^(выход|стоп|хватит|закрой|закройся|пока|отмена|отключись|до свидания)$/i;
  if (exitPhrases.test(text)) {
    return res.status(200).json(aliceResponse("Всего доброго! Будут вопросы — обращайтесь.", true, []));
  }

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на любой вопрос или найти свежую информацию в интернете. О чём рассказать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    const hasSerperKey = Boolean(process.env.SERPER_API_KEY || process.env.SEPER_API_KEY);

    if (isSearchIntent(text) && hasSerperKey) {
      // Выделяем до 1600 мс на поиск, гарантируя запас времени для ответа Gemini
      const searchBudget = Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2000));
      searchContext = await searchWeb(text, searchBudget);
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 200))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory, cleanSearchQuery };
