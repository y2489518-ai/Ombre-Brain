
  /* Theme: two presets (light=Pearl / harbor). Persisted in localStorage companion_theme. Set data-theme early to avoid a first-paint flash. */
  (function(){
    var THEMES = ["light","harbor"];
    try{
      var t = localStorage.getItem("companion_theme");
      if (THEMES.indexOf(t) < 0) t = "light";
      document.documentElement.setAttribute("data-theme", t);
    }catch(e){ document.documentElement.setAttribute("data-theme", "light"); }
  })();
