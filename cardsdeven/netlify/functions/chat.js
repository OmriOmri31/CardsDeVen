export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { query, history, systemInstruction } = JSON.parse(event.body);
    const apiKey = process.env.GEMINI_API_KEY;
    const modelCandidates = [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash"
    ];

    const truncate = (value, maxChars) => {
      if (!value) return '';
      const asString = String(value);
      return asString.length > maxChars ? `${asString.slice(0, maxChars)}\n...[truncated]` : asString;
    };

    const optimizedSystemInstruction = truncate(systemInstruction, 2200);
    const optimizedQuery = truncate(query, 1200);
    const optimizedHistory = (Array.isArray(history) ? history : [])
      .slice(-8)
      .map((msg) => ({
        role: msg?.role === 'user' ? 'user' : 'model',
        text: truncate(msg?.text || '', 700)
      }));

    const payload = {
      contents: [
        ...optimizedHistory.filter((msg, idx) => !(idx === 0 && msg.role === 'model')).map(msg => ({
          role: msg.role,
          parts: [{ text: msg.text }]
        })),
        { role: "user", parts: [{ text: optimizedQuery }] }
      ],
      systemInstruction: { parts: [{ text: optimizedSystemInstruction }] }
    };

    const retryDelaysMs = [2000, 4000, 8000];
    let response;
    let lastErrorText = '';
    let usedModel = modelCandidates[0];

    for (const model of modelCandidates) {
      usedModel = model;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      let attempt = 0;

      while (attempt <= retryDelaysMs.length) {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        console.log('[Gemini] model/status:', model, response.status);
        console.log('[Gemini] headers:', {
          retryAfter: response.headers.get('retry-after'),
          xRateLimitLimit: response.headers.get('x-ratelimit-limit'),
          xRateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
          xRateLimitReset: response.headers.get('x-ratelimit-reset')
        });

        if (response.ok) break;

        if (response.status === 404) {
          lastErrorText = await response.text();
          console.log(`[Gemini] model not found: ${model}. Trying next fallback model.`);
          break;
        }

        if (response.status === 429 && attempt < retryDelaysMs.length) {
          const waitMs = retryDelaysMs[attempt];
          console.log(`[Gemini] 429 received on ${model}. Retrying in ${waitMs}ms (attempt ${attempt + 1}/${retryDelaysMs.length})`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          attempt += 1;
          continue;
        }

        lastErrorText = await response.text();
        break;
      }

      if (response?.ok) break;
      if (response?.status && response.status !== 404) break;
    }

    if (!response.ok) {
      const errorDetails = lastErrorText || (await response.text());
      return { statusCode: response.status, body: JSON.stringify({ error: errorDetails, model: usedModel }) };
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "לא בטוח איך לענות על זה כרגע.";

    return { statusCode: 200, body: JSON.stringify({ result: text }) };
  } catch (error) {
    console.error("Backend Error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
