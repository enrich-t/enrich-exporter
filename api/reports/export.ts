import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = process.env.SUPABASE_BUCKET || "enrich-reports";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Minimal CORS
function withCORS(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req: any, res: any) {
  withCORS(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    const { json_url, format = "pdf" } = (req.body || {}) as { json_url?: string; format?: string };
    if (!json_url) return res.status(400).json({ error: "missing_json_url" });
    if (format !== "pdf") return res.status(400).json({ error: "unsupported_format" });

    // 1) Fetch report JSON
    const r = await fetch(json_url);
    if (!r.ok) return res.status(400).json({ error: "invalid_json_url" });
    const content = await r.json();

    // 2) Render HTML
    const html = renderHTML(content);

    // 3) Launch headless Chrome and create PDF
    const exePath = await chromium.executablePath(); // may be null locally; fine on Vercel
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: exePath || undefined,
      headless: true // avoid TS complaint about chromium.headless
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "18mm", right: "12mm", bottom: "18mm", left: "12mm" }
    });
    await browser.close();

    // 4) Upload PDF next to report.json
    const { bizId, reportId } = parseReportPath(json_url);
    if (!bizId || !reportId) return res.status(400).json({ error: "cannot_parse_report_path" });
    const pdfPath = `${bizId}/${reportId}/report.pdf`;

    const { error: upErr } = await supabase.storage.from(BUCKET).upload(pdfPath, pdfBuffer, {
      cacheControl: "3600",
      contentType: "application/pdf",
      upsert: true
    });
    if (upErr) throw upErr;

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(pdfPath);
    return res.status(200).json({ ok: true, url: data.publicUrl });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
}

function parseReportPath(jsonUrl: string): { bizId: string | null; reportId: string | null } {
  try {
    const u = new URL(jsonUrl);
    // .../storage/v1/object/public/enrich-reports/<biz>/<report>/report.json
    const m = u.pathname.match(/\/enrich-reports\/([^/]+)\/([^/]+)\/report\.json$/);
    return { bizId: m?.[1] ?? null, reportId: m?.[2] ?? null };
  } catch {
    return { bizId: null, reportId: null };
  }
}

function escapeHtml(s: string) {
  return String(s || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m] as string));
}
function escapeAttr(s: string) { return escapeHtml(s).replace(/"/g, "%22"); }

function renderHTML(content: any) {
  const h = content.header || {};
  const s = content.sections || {};
  const badge = s.overview?.growth_transparency_badge || "Initiated";

  return /* html */ `
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(h.business_name || "Business Overview")}</title>
<style>
  body { font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #111; padding: 16px; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:1px solid #e5e7eb; padding:16px 0; }
  .h-title { font-size:20px; font-weight:700; }
  .h-meta { color:#555; font-size:12px; }
  .section { padding:12px 0; }
  .k { font-weight:600; margin-bottom:4px; }
  .pill { display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; background:#f3f4f6; }
  .grid-2 { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
  @media print { [data-no-print="true"]{ display:none !important; } }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="h-title">${escapeHtml(h.business_name || "Business")}</div>
      <div class="h-meta">
        ${h.location_city ? escapeHtml(h.location_city) : ""}${h.location_city && h.location_country ? ", " : ""}${h.location_country ? escapeHtml(h.location_country) : ""}
        ${h.website_url ? ` • <a href="${escapeAttr(h.website_url)}">${escapeHtml(h.website_url)}</a>` : ""}
        ${h.contact_email ? ` • ${escapeHtml(h.contact_email)}` : ""}
      </div>
    </div>
    <div><span class="pill">${escapeHtml(badge)}</span></div>
  </div>

  <div class="section">
    <div class="k">Executive Summary</div>
    <div>${escapeHtml(s.overview?.ai_summary || "")}</div>
  </div>

  <div class="grid-2">
    <div class="section">
      <div class="k">Goals</div>
      <div>${escapeHtml(s.overview?.goals || "")}</div>
    </div>
    <div class="section">
      <div class="k">Certifications</div>
      <div>${escapeHtml(s.overview?.certifications || "")}</div>
    </div>
  </div>

  <div class="grid-2">
    <div class="section">
      <div class="k">Operations</div>
      <div>${escapeHtml(s.operations?.information || "")}</div>
    </div>
    <div class="section">
      <div class="k">Standards (UN / National)</div>
      <div>${escapeHtml(s.standards?.global_unwto || "")}</div>
      <div>${escapeHtml(s.standards?.national_ctc || "")}</div>
    </div>
  </div>

  <div class="grid-2">
    <div class="section">
      <div class="k">Local Impact</div>
      <div>${escapeHtml(s.local_impact?.information || "")}</div>
    </div>
    <div class="section">
      <div class="k">People & Partnerships</div>
      <div>${escapeHtml(s.people_partnerships?.information || "")}</div>
    </div>
  </div>

  <div class="grid-2">
    <div class="section">
      <div class="k">Insight — Local Suppliers</div>
      <div>${escapeHtml(s.insights?.local_suppliers || "")}</div>
    </div>
    <div class="section">
      <div class="k">Insight — Employee</div>
      <div>${escapeHtml(s.insights?.employee || "")}</div>
    </div>
  </div>

  <div class="section">
    <div class="k">Insight — Economic</div>
    <div>${escapeHtml(s.insights?.economic || "")}</div>
  </div>

  <div class="grid-2">
    <div class="section">
      <div class="k">Recommendations — Goals</div>
      <div>${escapeHtml(s.recommendations?.goals || "")}</div>
    </div>
    <div class="section">
      <div class="k">Recommendations — Operations</div>
      <div>${escapeHtml(s.recommendations?.operations || "")}</div>
    </div>
  </div>
</body>
</html>`;
}
