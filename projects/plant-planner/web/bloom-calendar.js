// bloom-calendar.js — Garden-wide bloom calendar strip below the 3D pane

var bloomCalendarExpanded = (window.innerWidth >= 600);

function _toggleBloomCalendar() {
  bloomCalendarExpanded = !bloomCalendarExpanded;
  renderBloomCalendar();
}

function _bloomCalendarHeaderHtml(placements, expanded) {
  // Tally bloom counts per month across all placed plants
  var counts = [0,0,0,0,0,0,0,0,0,0,0,0];
  var monthsSet = {};
  var uniquePlants = {};
  for (var i = 0; i < placements.length; i++) {
    var pl = placements[i].plant;
    if (!pl || !Array.isArray(pl.bloom_months)) continue;
    if (pl.bloom_months.length > 0) uniquePlants[pl.id] = true;
    for (var j = 0; j < pl.bloom_months.length; j++) {
      var m = pl.bloom_months[j];
      if (m >= 1 && m <= 12) {
        counts[m-1] += 1;
        monthsSet[m] = true;
      }
    }
  }
  var maxCount = 0;
  for (var k = 0; k < 12; k++) if (counts[k] > maxCount) maxCount = counts[k];
  var plantCount = Object.keys(uniquePlants).length;
  var monthCount = Object.keys(monthsSet).length;
  var hasAny = placements.length > 0;

  var chev = expanded ? 'chevron-down' : 'chevron-right';
  var html = '<header class="bloom-calendar-header" data-expanded="' + (expanded ? 'true' : 'false') + '">';
  html += '<div class="bloom-calendar-row-label">';
  html += '<button type="button" class="bloom-calendar-toggle" aria-label="Toggle bloom calendar"><i data-lucide="' + chev + '"></i></button>';
  html += '<span class="bloom-calendar-title">Bloom Calendar</span>';
  if (hasAny) {
    html += '<span class="bloom-calendar-count">' + plantCount + ' plant' + (plantCount === 1 ? '' : 's') + ' &middot; ' + monthCount + ' mo</span>';
  } else {
    html += '<span class="bloom-calendar-count">Add plants to see their bloom calendar</span>';
  }
  html += '</div>';

  html += '<div class="bloom-calendar-aggregate">';
  for (var mo = 1; mo <= 12; mo++) {
    var c = counts[mo-1];
    var op = (maxCount > 0 && c > 0) ? (c / maxCount) : 0;
    var intensity = op > 0 ? '1' : '0';
    var style = op > 0 ? ('opacity:' + op.toFixed(2)) : '';
    html += '<div class="bloom-calendar-month-cell">';
    html += '<span class="bloom-calendar-month-label">' + MONTH_LETTERS[mo-1] + '</span>';
    html += '<span class="bloom-calendar-aggregate-cell" data-intensity="' + intensity + '"' + (style ? ' style="' + style + '"' : '') + '></span>';
    html += '</div>';
  }
  html += '</div>';

  html += '</header>';
  return html;
}

function _bloomCalendarBodyHtml(placements) {
  if (placements.length === 0) return '';

  // Group by plantId so duplicates render as one row "×N"
  var groups = {};
  var order = [];
  for (var i = 0; i < placements.length; i++) {
    var pl = placements[i].plant;
    if (!pl) continue;
    if (!Array.isArray(pl.bloom_months) || pl.bloom_months.length === 0) continue;
    if (!groups[pl.id]) {
      groups[pl.id] = { plant: pl, count: 0 };
      order.push(pl.id);
    }
    groups[pl.id].count += 1;
  }

  if (order.length === 0) {
    return '<div class="bloom-calendar-body"><div class="bloom-calendar-empty">None of the placed plants have bloom data — try adding a flowering plant from the catalog.</div></div>';
  }

  var html = '<div class="bloom-calendar-body">';
  for (var k = 0; k < order.length; k++) {
    var g = groups[order[k]];
    var p = g.plant;
    var set = {};
    p.bloom_months.forEach(function(m) { set[m] = true; });
    var thumb = (typeof getPlantThumbnail === 'function') ? getPlantThumbnail(p, renderStyle) : '';
    var label = escapeHtml(p.name) + (g.count > 1 ? ' &times;' + g.count : '');
    html += '<div class="bloom-calendar-row">';
    html += '<div class="bloom-calendar-row-label">';
    if (thumb) html += '<img src="' + thumb + '" alt="" />';
    html += '<span>' + label + '</span>';
    html += '</div>';
    for (var mo = 1; mo <= 12; mo++) {
      html += '<span class="bloom-dot' + (set[mo] ? ' on' : '') + '"></span>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderBloomCalendar() {
  var container = document.getElementById('bloom-calendar-strip');
  if (!container) return;
  var list = (typeof placements !== 'undefined' && Array.isArray(placements)) ? placements : [];
  var expanded = bloomCalendarExpanded;
  var html = _bloomCalendarHeaderHtml(list, expanded);
  if (expanded) html += _bloomCalendarBodyHtml(list);
  container.innerHTML = html;

  if (window.lucide) {
    requestAnimationFrame(function() { lucide.createIcons(); });
  }

  var toggleBtn = container.querySelector('.bloom-calendar-toggle');
  if (toggleBtn) toggleBtn.onclick = _toggleBloomCalendar;
}
