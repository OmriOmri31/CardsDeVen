export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { query, history, systemInstruction } = JSON.parse(event.body);
    const apiKey = process.env.GEMINI_API_KEY;
    const model = "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const payload = {
      contents: [
        ...history.filter((msg, idx) => !(idx === 0 && msg.role === 'model')).map(msg => ({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.text }]
        })),
        { role: "user", parts: [{ text: query }] }
      ],
      systemInstruction: { parts: [{ text: systemInstruction }] }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorDetails = await response.text();
      return { statusCode: response.status, body: errorDetails };
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "לא בטוח איך לענות על זה כרגע.";

    return { statusCode: 200, body: JSON.stringify({ result: text }) };
  } catch (error) {
    console.error("Backend Error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
