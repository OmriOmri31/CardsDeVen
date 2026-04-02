const { GoogleGenerativeAI } = require('@google/generativeai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Cosine Similarity Math Formula
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { query, history, systemInstruction, userClubs, walletString, merchantNames } = JSON.parse(event.body);

    // 1. Fetch the giant JSON file containing the math vectors from your live site
    // (We do this dynamically so it's always the freshest scrape)
    const host = event.headers.host;
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const dataUrl = `${protocol}://${host}/data.json`;
    
    let vectorDeals = [];
    try {
      const dataRes = await fetch(dataUrl);
      const fullData = await dataRes.json();
      vectorDeals = fullData.vectors || [];
    } catch (e) {
      console.error("Could not fetch data.json", e);
    }

    // 2. Filter down to ONLY deals the user is eligible for based on their active clubs
    const userClubIds = userClubs || ["BEHATSDAA", "PAIS_PLUS", "DREAMCARD"];
    const eligibleDeals = vectorDeals.filter(deal => userClubIds.includes(deal.c));

    let topDealsText = "No specific deals found.";

    if (eligibleDeals.length > 0) {
      // 3. Turn the user's question into a math vector
      const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
      const embeddingResult = await embeddingModel.embedContent(query);
      const userVector = embeddingResult.embedding.values;

      // 4. Calculate similarity and grab the Top 40 closest matches
      const scoredDeals = eligibleDeals.map(deal => {
        return {
          ...deal,
          score: cosineSimilarity(userVector, deal.v)
        };
      });

      scoredDeals.sort((a, b) => b.score - a.score);
      const top40 = scoredDeals.slice(0, 40);
      topDealsText = top40.map(d => `${d.m} - ${d.d}`).join(' | ');
    }

    // 5. Inject the surgically precise top 40 deals into the prompt
    const finalSystemInstruction = `${systemInstruction}
    
USER'S DATA:
- Active Discount Deals (Mathematically sorted for this specific query): ${topDealsText}
- Wallet Cards: ${walletString || 'Empty'}
- Supported Merchants: ${merchantNames || 'None'}`;

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: finalSystemInstruction
    });

    const chat = model.startChat({ history: history || [] });
    const result = await chat.sendMessage(query);
    const responseText = result.response.text();

    return {
      statusCode: 200,
      body: JSON.stringify({ result: responseText })
    };

  } catch (error) {
    console.error("AI RAG Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};