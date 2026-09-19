import test from "node:test";
import assert from "node:assert/strict";
import { cleanCanvasText, htmlToText, vttToText } from "../helper/lib/text.mjs";
import { renderContext } from "../helper/lib/render-context.mjs";
import { fileSlug, safeName } from "../helper/lib/sanitize.mjs";

test("htmlToText strips markup and decodes entities", () => {
  assert.equal(htmlToText("<p>Limits &amp; continuity<br>Week&nbsp;1</p>"), "Limits & continuity\nWeek 1");
});

test("vttToText removes timing and headers", () => {
  const text = vttToText("WEBVTT\n\n1\n00:00:00 --> 00:00:02\nHello class\n");
  assert.equal(text, "Hello class");
});

test("cleanCanvasText removes Canvas module requirement boilerplate", () => {
  const text = cleanCanvasText(`Score at least
Must score at least to complete this module item

Lecture notes
Lecture notes
Important theorem`);
  assert.equal(text, "Lecture notes\nImportant theorem");
});

test("safe filenames are stable", () => {
  assert.equal(safeName(" Math 60: Week/1 "), "Math 60 Week1");
  assert.equal(fileSlug("Math 60 Lecture 1.mp4"), "math-60-lecture-1.mp4");
});

test("renderContext includes Canvas and media sections", () => {
  const markdown = renderContext({
    binName: "Math 60",
    course: {
      name: "Math 60",
      htmlUrl: "https://canvas.example.edu/courses/123",
      summary: { assignmentCount: 1, discussionCount: 1, fileCount: 0, moduleCount: 0, pageCount: 0 },
      assignments: [{ id: 1, name: "Homework 1", description: "<p>Do problems 1-10.</p>" }],
      discussions: [{ id: 2, title: "Week 1", entries: [{ author: "A", message: "<p>Question?</p>" }] }],
      files: [],
      modules: [],
      pages: []
    },
    media: [{ title: "Lecture 1", transcriptText: "Derivative basics" }]
  });
  assert.match(markdown, /# Math 60/);
  assert.match(markdown, /Homework 1/);
  assert.match(markdown, /Derivative basics/);
});
