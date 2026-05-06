import { QuartzLayout } from "./quartz/types"

const layout: QuartzLayout = {
  sharedComponents: {
    head: Component.Head(),
    footer: Component.Footer({
      links: {
        GitHub: "https://github.com/zarguell/research-reports",
      },
    }),
  },
  homePage: {
    frontmatter: {
      title: "Research Reports",
      description: "AI-generated research reports by Hermes",
    },
    pageComponents: [
      Component.Flex({
        children: [
          Component.Sidebar(),
          Component.Spacer(),
          Component.PageList(),
        ],
      }),
      Component.Search(),
      Component.Darkmode(),
      Component.Backlinks(),
    ],
  },
  defaultContentPage: {
    frontmatter: {},
    pageComponents: [
      Component.Flex({
        children: [
          Component.Sidebar(),
          Component.Spacer(),
          Component.Article(),
        ],
      }),
      Component.Search(),
      Component.Darkmode(),
      Component.Backlinks(),
    ],
  },
  404: {
    pageComponents: [Component.NotFound()],
  },
}

export default layout
