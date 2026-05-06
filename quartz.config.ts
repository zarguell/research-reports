import { QuartzConfig } from "./quartz/types"

const config: QuartzConfig = {
  siteTitle: "Research Reports",
  enableSPA: true,
  enableLatex: true,
  enableMacros: false,
  analytics: null,
  baseUrl: "https://zarguell.github.io/research-reports",
  ignorePatterns: ["templates/**", ".obsidian/**", "placeholder.md"],
  theme: {
    fontOrigin: "googleFonts",
    cdnCaching: true,
    typography: {
      header: "Libre Baskerville",
      body: "Source Sans 3",
      code: "IBM Plex Mono",
    },
    colors: {
      lightMode: {
        light: "#faf8f5",
        lightgray: "#e5e5e5",
        gray: "#b8b8b8",
        darkgray: "#4e4e4e",
        dark: "#2c2c2c",
        secondary: "#284b63",
        tertiary: "#84a98c",
        link: "#3d5a80",
      },
      darkMode: {
        light: "#161618",
        lightgray: "#2e2e2e",
        gray: "#515151",
        darkgray: "#b8b8b8",
        dark: "#ede4d4",
        secondary: "#84a98c",
        tertiary: "#6b9080",
        link: "#84a98c",
      },
    },
  },
  defaultDateType: "created",
  plugins: {
    transformers: [
      plugin.Frontmatter(),
      plugin.CreatedModifiedDate({
        priority: ["frontmatter", "filesystem"],
      }),
      plugin.SyntaxHighlighting({
        theme: "one-dark",
        keepBackground: false,
      }),
      plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      plugin.GitHubFlavoredMarkdown(),
      plugin.TableOfContents(),
      plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      plugin.Latex({ renderEngine: "katex" }),
      plugin.Spoiler(),
    ],
    filters: [
      plugin.RemoveDrafts(),
      plugin.ExplicitPublish(),
      plugin.LowercaseTag(),
      plugin.RemoveOrphans(),
    ],
    emitters: [
      plugin.IndexPage(),
      plugin.TagPages(),
      plugin.ComponentResources(),
      plugin.ContentPage(),
      plugin.FolderPage(),
      plugin.TagRSS(),
      plugin.AssetEmitters(),
      plugin.NotFoundPage(),
      plugin.GraphPage(),
    ],
  },
}

export default config
