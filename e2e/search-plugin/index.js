// A stand-in web search provider for the live test, loaded next to the courier: with it, a child's
// web search asks OpenCode's provider form, and once the person picks it, searches offline.
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
