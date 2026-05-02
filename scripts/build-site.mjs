import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths & config ──────────────────────────────────────────────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(repoRoot, "dist");
const gramaxCli = join(repoRoot, "node_modules", ".bin", "gramax-cli");

const SITE_BASE_URL = process.env.DOC_SITE_BASE_URL || "https://docs.bug-buster.ru";
/** Суффикс в <title> вкладки (шапка каталога остаётся короткой — .doc-root: BugBuster). */
const TAB_TITLE_SUFFIX = "Руководство пользователя";
const FAVICON_BRAND_COLOR = "#5503FF";
const FAVICON_SVG_PATH = join(repoRoot, "catalog", "assets", "bugbuster-mark-favicon.svg");

// ── Build ───────────────────────────────────────────────────────────────────

function buildSite() {
  execFileSync(
    gramaxCli,
    [
      "build",
      "-s", "./catalog",
      "-d", "./dist",
      "-cc", "./gramax-portal.css",
      "--base-url", SITE_BASE_URL,
      "-l",
    ],
    { stdio: "inherit", cwd: repoRoot },
  );
  writeFileSync(join(distRoot, ".nojekyll"), "");
}

// ── HTML post-processing ────────────────────────────────────────────────────

/**
 * Пути относительные — корректно резолвятся и по `<base href>` Gramax-страниц
 * (всегда указывает на корень `dist/`), и по адресу самого `dist/index.html`,
 * который тоже лежит в `dist/`. Поэтому один блок ссылок подходит всем.
 */
const FAVICON_LINKS = [
  '<link rel="icon" href="favicon.ico" sizes="any">',
  '<link rel="icon" href="favicon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="favicon.png">',
].join("\n  ");

function* walkHtmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkHtmlFiles(p);
    else if (entry.isFile() && p.endsWith(".html")) yield p;
  }
}

function patchHtmlFile(file) {
  const original = readFileSync(file, "utf8");
  let html = original;

  html = html.replace(/\| BugBuster<\/title>/g, `| ${TAB_TITLE_SUFFIX}</title>`);
  html = html.replace(/<title>catalog<\/title>/g, `<title>${TAB_TITLE_SUFFIX}</title>`);

  if (!/<link\b[^>]*\brel\s*=\s*["']icon["']/i.test(html)) {
    html = html.replace(/<head(\s[^>]*)?>/i, (open) => `${open}\n  ${FAVICON_LINKS}`);
  }

  if (html !== original) writeFileSync(file, html);
}

function patchBuiltHtml() {
  for (const file of walkHtmlFiles(distRoot)) patchHtmlFile(file);
}

// ── Favicon generation ──────────────────────────────────────────────────────

/**
 * Исходная SVG адаптивна (prefers-color-scheme) — её CSS-заливка теряется
 * при растрировании. Для ICO/PNG берём только `d` пути и заливаем брендом.
 */
function flattenAdaptiveSvg(adaptiveSvgText) {
  const match = adaptiveSvgText.match(/<path[^>]*\bd="([^"]+)"/);
  if (!match) throw new Error(`${FAVICON_SVG_PATH}: path d= not found`);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 25 25">` +
      `<path fill="${FAVICON_BRAND_COLOR}" d="${match[1]}"/>` +
      `</svg>`,
  );
}

async function writeFavicons() {
  const { default: sharp } = await import("sharp");
  const { default: toIco } = await import("to-ico");

  const adaptiveSvg = readFileSync(FAVICON_SVG_PATH);
  const flatSvg = flattenAdaptiveSvg(adaptiveSvg.toString("utf8"));

  const icoSizes = [16, 32, 48];
  const icoPngs = await Promise.all(
    icoSizes.map((size) => sharp(flatSvg).resize(size, size).png().toBuffer()),
  );

  writeFileSync(join(distRoot, "favicon.ico"), await toIco(icoPngs));
  writeFileSync(join(distRoot, "favicon.svg"), adaptiveSvg);
  await sharp(flatSvg).resize(32, 32).png().toFile(join(distRoot, "favicon.png"));
}

// ── Pipeline ────────────────────────────────────────────────────────────────

buildSite();
await writeFavicons();
patchBuiltHtml();
