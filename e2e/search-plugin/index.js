export default {
  id: "courier-e2e-search",
  setup: async (ctx) => {
    await ctx.websearch.transform((editor) =>
      editor.add({
        id: "courier-search",
        name: "Courier Search",
        execute: async ({ query }) => [
          { url: "https://example.com/courier", title: `Courier result for ${query}`, content: "COURIER SEARCH RESULT", time: {} },
        ],
      }),
    )
  },
}
