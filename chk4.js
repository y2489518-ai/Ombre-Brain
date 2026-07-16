
/* 她的头像：点聊天里自己的头像圈就能换 存本地 顺手压到256px防塞爆仓库 */
(function(){
  const KEY = "companion_avatar_human";
  function applyHumanAvatar(url){
    document.documentElement.style.setProperty("--avatar-human", url ? `url("${url}")` : "none");
    document.documentElement.classList.toggle("has-human-avatar", !!url);
  }
  applyHumanAvatar(localStorage.getItem(KEY));
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/*"; input.className = "hidden";
  document.body.appendChild(input);
  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(256 / img.width, 256 / img.height, 1);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * s));
        c.height = Math.max(1, Math.round(img.height * s));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const dataUrl = c.toDataURL("image/jpeg", 0.85);
        applyHumanAvatar(dataUrl);
        try{ localStorage.setItem(KEY, dataUrl); }catch(e){}
      };
      img.src = r.result;
    };
    r.readAsDataURL(f);
    input.value = "";
  });
  document.addEventListener("click", (e) => {
    const av = e.target.closest(".row.human .mavatar");
    if (av) input.click();
  });
})();
