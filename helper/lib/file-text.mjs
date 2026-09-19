import { promises as fs } from "node:fs";
import { extname } from "node:path";
import { PDFParse } from "pdf-parse";
import { cleanCanvasText, htmlToText } from "./text.mjs";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".xml", ".vtt", ".srt", ".py", ".js", ".ts", ".r", ".java", ".c", ".cpp"]);

export async function extractReadableText(filePath, { contentType = "", maxChars = 250000 } = {}) {
  const extension = extname(filePath).toLowerCase();
  const type = String(contentType || "").toLowerCase();

  if (extension === ".pdf" || type.includes("pdf")) {
    return extractPdfText(filePath, maxChars);
  }

  if (extension === ".html" || extension === ".htm" || type.includes("html")) {
    return htmlToText((await fs.readFile(filePath, "utf8")).slice(0, maxChars * 2)).slice(0, maxChars);
  }

  if (extension === ".ipynb") {
    return extractNotebookText(filePath, maxChars);
  }

  if (TEXT_EXTENSIONS.has(extension) || type.startsWith("text/")) {
    return cleanCanvasText((await fs.readFile(filePath, "utf8")).slice(0, maxChars));
  }

  return "";
}

async function extractPdfText(filePath, maxChars) {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText({ pageJoiner: "\n\n" });
    return cleanCanvasText(String(result.text || "").slice(0, maxChars));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractNotebookText(filePath, maxChars) {
  const notebook = JSON.parse(await fs.readFile(filePath, "utf8"));
  const lines = [];
  for (const cell of notebook.cells || []) {
    const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
    if (!source.trim()) continue;
    lines.push(`## ${cell.cell_type || "cell"}`);
    lines.push(source.trim());
  }
  return cleanCanvasText(lines.join("\n\n").slice(0, maxChars));
}
