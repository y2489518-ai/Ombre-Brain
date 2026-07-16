
(function(){
  const EMOJIS = ["😊","🥰","😘","😚","🤭","😁","😆","🥹","🥺","😭","😤","🙄","😴","🤤","😳","🫠","🤯","🫡","🤗","😼","🐷","🐶","❤️","🧡","💛","💕","💞","💋","✨","🔥","🌙","🌧️","⭐","🎉","🫶","👍","👀","🙏","🤝","🍜","🧋","🛏️"];
  const btn = document.getElementById("emojiBtn");
  const input = document.getElementById("input");
  if (!btn || !input) return;
  const pop = document.createElement("div");
  pop.className = "emoji-pop";
  EMOJIS.forEach(em => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = em;
    b.addEventListener("click", () => {
      const s = input.selectionStart ?? input.value.length;
      const e2 = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, s) + em + input.value.slice(e2);
      const pos = s + em.length;
      input.setSelectionRange(pos, pos);
      input.dispatchEvent(new Event("input", {bubbles:true}));   // 触发自适应高度/发送键状态
    });
    pop.appendChild(b);
  });
  document.body.appendChild(pop);
  btn.addEventListener("click", (e) => { e.preventDefault(); pop.classList.toggle("open"); });
  document.addEventListener("click", (e) => {
    if (pop.classList.contains("open") && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) pop.classList.remove("open");
  });
  const send = document.getElementById("sendBtn");
  if (send) send.addEventListener("click", () => pop.classList.remove("open"));
})();
