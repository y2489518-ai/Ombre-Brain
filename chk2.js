
/* 总监罚单#2：滑动手势——右滑=返回上一层(聊天→菜单 / 资料页→关) 左滑=关菜单回聊天 */
(function(){
  let x0=0, y0=0, t0=0, tracking=false;
  document.addEventListener("touchstart", (e)=>{
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); tracking = true;
  }, {passive:true});
  document.addEventListener("touchend", (e)=>{
    if (!tracking) return; tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
    if (dt > 600 || Math.abs(dy) > 60 || Math.abs(dx) < 70) return;
    const profileOpen = typeof profilePanel !== "undefined" && profilePanel && !profilePanel.classList.contains("hidden");
    const menuOpen = typeof menuPanel !== "undefined" && menuPanel && !menuPanel.classList.contains("hidden");
    if (dx > 0){            // 右滑：一层层退
      if (profileOpen) closeProfile();
      else if (menuOpen) return;      // 菜单已是最外层
      else openMenu();                 // 聊天页右滑=回主菜单
    } else {                // 左滑：从菜单回聊天
      if (menuOpen && !profileOpen) closeMenu();
    }
  }, {passive:true});
})();
