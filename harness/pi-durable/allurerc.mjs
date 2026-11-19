// The official Allure 3 renderer consumes the grader's lifecycle JSON directly.
// A single file can be reviewed locally before publication.
export default {
  name: "Löyly booking core",
  plugins: {
    awesome: {
      options: {
        reportName: "Löyly booking core",
        singleFile: true,
        groupBy: ["feature", "story"],
      },
    },
  },
};
