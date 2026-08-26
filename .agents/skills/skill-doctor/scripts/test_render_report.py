#!/usr/bin/env python3
"""Tests for the self-contained skill-doctor report renderer."""

import unittest

from render_report import render_diff


class ReportRendererTests(unittest.TestCase):
    def test_renders_an_escaped_self_contained_diff(self):
        rendered = render_diff("- <old>\n+ <new>", "/tmp/SKILL.md")

        self.assertIn('<div class="diff-filename">SKILL.md</div>', rendered)
        self.assertIn('<pre class="diff-view diff-fallback">', rendered)
        self.assertIn("&lt;old&gt;", rendered)
        self.assertNotIn("data-pierre-diff", rendered)


if __name__ == "__main__":
    unittest.main()
