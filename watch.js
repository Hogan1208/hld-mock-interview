const fs = require("fs");
const dir = "/Users/mayank.garg/Desktop/hld-mock/live";
const qfile = dir + "/questions.jsonl";
const ansdir = dir + "/answers";
function questions() {
  try {
    return fs.readFileSync(qfile, "utf8").trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
function answered(id) { try { return fs.existsSync(ansdir + "/" + id + ".txt"); } catch (e) { return false; } }
(function loop() {
  const pending = questions().find(x => x.id && !answered(x.id));
  if (pending) { console.log("NEW_QUESTION " + JSON.stringify(pending)); process.exit(0); }
  setTimeout(loop, 1500);
})();
