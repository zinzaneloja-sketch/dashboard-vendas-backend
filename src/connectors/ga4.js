const axios = require("axios");

const CLIENT_ID = process.env.GA4_CLIENT_ID;
const CLIENT_SECRET = process.env.GA4_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GA4_REFRESH_TOKEN;

const PROPERTY_WEB = process.env.GA4_PROPERTY_ID_WEB;
const PROPERTY_APP = process.env.GA4_PROPERTY_ID_APP;

let cachedToken = null;
let cachedTokenExpiresAt = 0;

/** Troca o refresh token por um access token válido (com cache em memória). */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) {
    return cachedToken;
  }

  const { data } = await axios.post("https://oauth2.googleapis.com/token", null, {
    params: {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    },
  });

  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken;
}

/**
 * Executa um relatório na GA4 Data API (runReport).
 * property: "web" | "app" | um propertyId numérico direto
 */
async function runReport(property, { dimensions = [], metrics = [], dateRanges, dimensionFilter, limit = 100000 }) {
  const propertyId =
    property === "web" ? PROPERTY_WEB : property === "app" ? PROPERTY_APP : property;

  if (!propertyId) {
    throw new Error(`GA4 property não configurada para "${property}"`);
  }

  const token = await getAccessToken();

  const body = {
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    dateRanges: dateRanges || [{ startDate: "30daysAgo", endDate: "today" }],
    limit,
  };
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;

  const { data } = await axios.post(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    body,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return parseReport(data);
}

/** Converte a resposta bruta da GA4 Data API em uma lista de objetos {dim1, dim2, metric1, ...}. */
function parseReport(data) {
  const dimHeaders = (data.dimensionHeaders || []).map((d) => d.name);
  const metricHeaders = (data.metricHeaders || []).map((m) => m.name);
  const rows = data.rows || [];

  return rows.map((row) => {
    const out = {};
    (row.dimensionValues || []).forEach((v, i) => {
      out[dimHeaders[i]] = v.value;
    });
    (row.metricValues || []).forEach((v, i) => {
      out[metricHeaders[i]] = Number(v.value);
    });
    return out;
  });
}

module.exports = { runReport, getAccessToken };
