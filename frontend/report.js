/* 运动库 SportDB — 今天页 nightly 日报展示（task-8）
 *
 * 数据来源：sync.yml nightly 步骤跑 scripts/build_report.py 生成的
 *   reports/daily/YYYY-MM-DD.md（日期为北京时间当日）。
 * 加载策略：今日.md → 昨日.md → 占位文案，三级降级，永远不抛错阻塞今天页。
 * 基址候选与 app.js 同思路：本地在 sport-db/ 根起服务时 ../reports 指向
 *   sport-db/reports；Pages 发布时 sync.yml 把 reports/daily 拷贝进前端产物，
 *   ./reports 命中。本文件只管日报展示，不碰聊天相关逻辑。
 */
'use strict';

(function () {
  var bodyEl = document.getElementById('report-body');
  if (!bodyEl) return; // 今天页没有报告卡片时静默退出
  var dateEl = document.getElementById('report-date');

  var PLACEHOLDER =
    '今日日报尚未生成。\n' +
    '每晚 06:30（北京时间）sync 工作流会自动生成运动日报并发布到这里。\n' +
    '若刚配好 VISION_ENDPOINT / VISION_MODEL，请等下一次定时跑或手动触发 sync。';

  // 日报基址候选（首个对应本地根服务布局，第二个对应 Pages 产物布局）
  var REPORT_BASES = ['../reports/', './reports/'];

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function render(text, label) {
    if (dateEl) dateEl.textContent = label || '';
    bodyEl.innerHTML = escapeHtml(text);
  }

  function renderPlaceholder() {
    if (dateEl) dateEl.textContent = '';
    bodyEl.innerHTML = escapeHtml(PLACEHOLDER);
  }

  async function fetchReport(dateStr) {
    var errors = [];
    for (var i = 0; i < REPORT_BASES.length; i++) {
      var url = REPORT_BASES[i] + 'daily/' + dateStr + '.md';
      try {
        var resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) { errors.push(url + ' HTTP ' + resp.status); continue; }
        return { text: await resp.text(), url: url };
      } catch (err) {
        errors.push(url + ': ' + (err.message || err));
      }
    }
    var e = new Error(errors.join('；'));
    e.reportErrors = errors;
    throw e;
  }

  async function loadReport() {
    var now = new Date();
    var today = fmtDate(now);
    var yesterday = fmtDate(new Date(now.getTime() - 864e5));
    try {
      var r = await fetchReport(today);
      render(r.text, today + '（今日）');
    } catch (errToday) {
      try {
        var y = await fetchReport(yesterday);
        render(y.text, yesterday + '（昨日，今日日报尚未生成）');
      } catch (errYesterday) {
        console.warn('[SportDB] 日报不可读（已试今日/昨日）：' + (errYesterday.message || errYesterday));
        renderPlaceholder();
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadReport);
  } else {
    loadReport();
  }

  // 对外暴露，方便控制台手动刷新：SportDBReport.reload()
  window.SportDBReport = { reload: loadReport };
})();
