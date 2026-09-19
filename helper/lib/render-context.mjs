import { htmlToText, vttToText } from "./text.mjs";

export function renderContext({ binName, course = null, media = [] }) {
  const lines = [
    `# ${binName}`,
    "",
    `Updated: ${new Date().toISOString()}`,
    ""
  ];

  if (course) {
    lines.push(`Source Canvas course: ${course.name}`);
    lines.push(`Canvas URL: ${course.htmlUrl}`);
    lines.push("");
    lines.push("## Course Snapshot");
    lines.push(`- Assignments: ${course.summary?.assignmentCount ?? course.assignments?.length ?? 0}`);
    lines.push(`- Discussions: ${course.summary?.discussionCount ?? course.discussions?.length ?? 0}`);
    lines.push(`- Files: ${course.summary?.fileCount ?? course.files?.length ?? 0}`);
    lines.push(`- Modules: ${course.summary?.moduleCount ?? course.modules?.length ?? 0}`);
    lines.push(`- Pages: ${course.summary?.pageCount ?? course.pages?.length ?? 0}`);
    lines.push("");
    if (course.warnings?.length) {
      lines.push("## Sync Warnings", "");
      for (const warning of course.warnings) lines.push(`- ${warning}`);
      lines.push("");
    }
    appendAssignments(lines, course.assignments || []);
    appendDiscussions(lines, course.discussions || []);
    appendPages(lines, course.pages || []);
    appendModules(lines, course.modules || []);
    appendFiles(lines, course.files || []);
  }

  appendMedia(lines, media);
  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function appendAssignments(lines, assignments) {
  lines.push("## Assignments", "");
  if (!assignments.length) {
    lines.push("No assignments captured.", "");
    return;
  }
  for (const assignment of assignments) {
    lines.push(`### ${assignment.name || `Assignment ${assignment.id}`}`);
    lines.push(`- Due: ${assignment.due_at || "No due date"}`);
    lines.push(`- Points: ${assignment.points_possible ?? "Unknown"}`);
    lines.push(`- URL: ${assignment.html_url || assignment.url || "N/A"}`);
    const description = htmlToText(assignment.description || "");
    if (description) lines.push("", description);
    lines.push("");
  }
}

function appendDiscussions(lines, discussions) {
  lines.push("## Discussions", "");
  if (!discussions.length) {
    lines.push("No discussions captured.", "");
    return;
  }
  for (const topic of discussions) {
    lines.push(`### ${topic.title || `Discussion ${topic.id}`}`);
    lines.push(`- Posted: ${topic.posted_at || topic.created_at || "Unknown"}`);
    lines.push(`- URL: ${topic.html_url || "N/A"}`);
    const message = htmlToText(topic.message || topic.detail?.message || "");
    if (message) lines.push("", message);
    if (topic.entries?.length) {
      lines.push("", "#### Posts");
      for (const entry of topic.entries) {
        const prefix = "  ".repeat(Math.min(entry.depth || 0, 6));
        lines.push(`${prefix}- ${entry.author || "Unknown"} (${entry.createdAt || "unknown date"}): ${htmlToText(entry.message || "")}`);
      }
    }
    lines.push("");
  }
}

function appendPages(lines, pages) {
  lines.push("## Pages", "");
  if (!pages.length) {
    lines.push("No pages captured.", "");
    return;
  }
  for (const page of pages) {
    lines.push(`### ${page.title || page.url}`);
    lines.push(`- URL: ${page.html_url || "N/A"}`);
    const body = htmlToText(page.body || "");
    if (body) lines.push("", body);
    lines.push("");
  }
}

function appendModules(lines, modules) {
  lines.push("## Modules", "");
  if (!modules.length) {
    lines.push("No modules captured.", "");
    return;
  }
  for (const module of modules) {
    lines.push(`### ${module.name || `Module ${module.id}`}`);
    for (const item of module.items || []) {
      lines.push(`- ${item.title || item.type || "Item"} (${item.type || "unknown"}): ${item.html_url || item.url || "N/A"}`);
    }
    lines.push("");
  }
}

function appendFiles(lines, files) {
  lines.push("## Files", "");
  if (!files.length) {
    lines.push("No files captured.", "");
    return;
  }
  for (const file of files) {
    lines.push(`### ${file.displayName || file.filename || `File ${file.id}`}`);
    lines.push(`- Type: ${file.contentType || "Unknown"}`);
    lines.push(`- Size: ${file.size ?? "Unknown"}`);
    lines.push(`- Updated: ${file.updatedAt || "Unknown"}`);
    lines.push(`- Canvas download URL: ${file.url || "N/A"}`);
    if (file.localPath) lines.push(`- Local file: ${file.localPath}`);
    if (file.binaryStatus) lines.push(`- File capture: ${file.binaryStatus}`);
    const readable = file.extractedText || file.text;
    if (readable) lines.push("", "```text", readable.slice(0, 250000), "```");
    else lines.push(`- Text capture: ${file.textStatus || "not captured"}`);
    lines.push("");
  }
}

function appendMedia(lines, media) {
  lines.push("## Lectures And Podcasts", "");
  if (!media.length) {
    lines.push("No lecture or podcast media captured yet.", "");
    return;
  }
  for (const item of media) {
    lines.push(`### ${item.title || "Lecture media"}`);
    lines.push(`- Page: ${item.pageUrl || "N/A"}`);
    lines.push(`- Captured: ${item.capturedAt || "Unknown"}`);
    lines.push(`- Source: ${item.source || "N/A"}`);
    if (item.transcriptPath) lines.push(`- Transcript file: ${item.transcriptPath}`);
    const transcript = item.transcriptText || vttToText(item.captionText || "");
    if (transcript) lines.push("", transcript);
    if (item.status && item.status !== "saved") lines.push(`- Status: ${item.status}`);
    lines.push("");
  }
}
