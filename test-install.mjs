const res = await fetch("https://api.github.com/repos/anthropics/claude-plugins-official/git/trees/fe07b5e1bdcca448b346738b7e28ec8959dc6173?recursive=1");
const data = await res.json();
const mdFiles = data.tree.filter(item => 
    item.type === "blob" && 
    item.path.endsWith(".md") && 
    (item.path.startsWith("agents/") || item.path.startsWith("commands/") || item.path.startsWith("skills/"))
);
console.log(mdFiles);
