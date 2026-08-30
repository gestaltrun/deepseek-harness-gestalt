# Platform homepage browser snapshot

## Head and links

```json
{
  "title": "Gestalt · 獭子哥",
  "lang": "zh-CN",
  "description": "Gestalt（獭子哥）是基于 DeepSeek Harness 构建的开源 AI coding agent（编程智能体）产品，提供桌面端、手机伴侣、会话回放和可组合插件。",
  "canonical": "https://www.gestaltrun.com/",
  "repositoryLinks": [
    "https://github.com/gestaltrun/deepseek-harness-gestalt",
    "https://github.com/gestaltrun/deepseek-harness-gestalt/releases"
  ],
  "jsonLd": "{\n  \"@context\": \"https://schema.org\",\n  \"@graph\": [\n    {\n      \"@type\": \"WebSite\",\n      \"@id\": \"https://www.gestaltrun.com/#website\",\n      \"url\": \"https://www.gestaltrun.com/\",\n      \"name\": \"Gestalt\",\n      \"alternateName\": [\"獭子哥\", \"DeepSeek Gestalt\"],\n      \"inLanguage\": [\"zh-CN\", \"en-US\"]\n    },\n    {\n      \"@type\": \"SoftwareApplication\",\n      \"@id\": \"https://www.gestaltrun.com/#software\",\n      \"name\": \"Gestalt\",\n      \"alternateName\": [\"獭子哥\", \"DeepSeek Gestalt\"],\n      \"url\": \"https://www.gestaltrun.com/\",\n      \"description\": \"An open-source AI coding agent product built on DeepSeek Harness, with desktop and mobile clients, replayable sessions, and composable plugins.\",\n      \"applicationCategory\": \"DeveloperApplication\",\n      \"operatingSystem\": [\"macOS\", \"Windows\", \"iOS\", \"Android\", \"Web\"],\n      \"image\": \"https://www.gestaltrun.com/images/hero-bg.png\",\n      \"downloadUrl\": \"https://github.com/gestaltrun/deepseek-harness-gestalt/releases\",\n      \"sameAs\": \"https://github.com/gestaltrun/deepseek-harness-gestalt\",\n      \"isBasedOn\": \"https://github.com/deepseek-ai/deepseek-harness\"\n    }\n  ]\n}"
}
```

## Social preview image

```json
{
  "status": 200,
  "type": "image/png",
  "bytes": 1456333
}
```

## Discovery responses

```json
[
  {
    "path": "/robots.txt",
    "status": 200,
    "type": "text/plain; charset=utf-8",
    "body": "User-agent: *\nAllow: /\nSitemap: https://www.gestaltrun.com/sitemap.xml\n"
  },
  {
    "path": "/sitemap.xml",
    "status": 200,
    "type": "application/xml; charset=utf-8",
    "body": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  <url>\n    <loc>https://www.gestaltrun.com/</loc>\n  </url>\n</urlset>\n"
  },
  {
    "path": "/llms.txt",
    "status": 200,
    "type": "text/plain; charset=utf-8",
    "body": "# Gestalt · 獭子哥\n\n> Gestalt is an open-source AI coding agent product built on DeepSeek Harness. It packages the compatible plugin runtime as desktop, mobile, and operated Platform experiences.\n\n## Product\n\nGestalt keeps the DeepSeek Harness plugin model and adds an installable desktop host, a paired mobile companion, replayable sessions, release delivery, and the production Platform service at this origin.\n\n## Links\n\n- Product: https://www.gestaltrun.com/\n- Source: https://github.com/gestaltrun/deepseek-harness-gestalt\n- Documentation: https://gestaltrun.github.io/deepseek-harness-gestalt/\n- Releases: https://github.com/gestaltrun/deepseek-harness-gestalt/releases\n- Official DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness\n\n## Languages\n\nThe product page contains Chinese and English content at the same canonical URL. Use the documentation site for linkable pages in each language.\n"
  }
]
```

## Chinese hero

- paragraph: DeepSeek Gestalt 开发者预览版
- heading "一切皆插件" [level=1]
- paragraph: DeepSeek Gestalt 是面向开发者的桌面端与手机端：同一条会话，可以在电脑上打开，也可以配对后在手机上继续。
- paragraph: 能力仍来自 DeepSeek Harness：模型、工具、技能、会话、沙箱、存储、循环、调度、UI 均由插件组合，可以自由替换。Gestalt 把这些能力做成可安装的桌面产品，并加上手机配对。
- link "查看 GitHub":
  - /url: https://github.com/gestaltrun/deepseek-harness-gestalt
  - img
  - text: 查看 GitHub
- link "下载桌面版":
  - /url: https://github.com/gestaltrun/deepseek-harness-gestalt/releases
- button "一键使用"
- button "源码安装"
- button "复制":
  - img
  - text: 复制
- text: $ git clone https://github.com/gestaltrun/deepseek-harness-gestalt.git

## English hero

- paragraph: DeepSeek Gestalt developer preview
- heading "Everything is a plugin" [level=1]
- paragraph: "DeepSeek Gestalt is the desktop and phone product: start a session on the computer, then continue the same session on a paired phone."
- paragraph: "The capabilities still come from DeepSeek Harness: models, tools, skills, sessions, sandboxes, storage, loops, schedules, and UI are plugins you can recombine. Gestalt ships them as an installable desktop app, plus phone pairing."
- link "View GitHub":
  - /url: https://github.com/gestaltrun/deepseek-harness-gestalt
  - img
  - text: View GitHub
- link "Download desktop":
  - /url: https://github.com/gestaltrun/deepseek-harness-gestalt/releases
- button "Quick start"
- button "From source"
- button "Copy":
  - img
  - text: Copy
- text: $ git clone https://github.com/gestaltrun/deepseek-harness-gestalt.git
