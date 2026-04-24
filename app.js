// PolySniper — Fetch stats.json and render live performance data

const STATS_URL = 'stats.json';

async function loadStats() {
    try {
        const resp = await fetch(STATS_URL);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const stats = await resp.json();
        renderStats(stats);
        renderSignals(stats.recent_signals || []);
    } catch (err) {
        console.warn('Failed to load stats:', err);
        document.getElementById('stats-updated').textContent = 'Stats unavailable — check back soon';
    }
}

function renderStats(stats) {
    document.getElementById('stat-bets').textContent = stats.total_bets || 0;
    document.getElementById('stat-wr').textContent = (stats.win_rate || 0) + '%';

    const pnl = stats.pnl || 0;
    const pnlEl = document.getElementById('stat-pnl');
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    pnlEl.style.color = pnl >= 0 ? 'var(--win)' : 'var(--loss)';

    const kellyPnl = stats.kelly_pnl || 0;
    const kellyEl = document.getElementById('stat-kelly-pnl');
    if (kellyEl) {
        kellyEl.textContent = (kellyPnl >= 0 ? '+' : '') + '$' + kellyPnl.toFixed(2);
        kellyEl.style.color = kellyPnl >= 0 ? 'var(--win)' : 'var(--loss)';
    }
    // Color the PnL card border based on overall
    const pnlCard = pnlEl && pnlEl.closest('.stat-card');
    if (pnlCard) {
        const overall = pnl + kellyPnl;
        pnlCard.style.borderColor = overall >= 0 ? 'var(--win)' : 'var(--loss)';
    }

    const streak = stats.current_streak || 0;
    const streakType = stats.streak_type || '';
    document.getElementById('stat-streak').textContent = streak + streakType;

    // Update timestamp
    if (stats.updated_at) {
        const d = new Date(stats.updated_at);
        document.getElementById('stats-updated').textContent =
            'Updated: ' + d.toLocaleString();
    }
}

function renderSignals(signals) {
    const tbody = document.getElementById('signals-body');
    if (!signals.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">No signals yet — bot is warming up</td></tr>';
        return;
    }

    tbody.innerHTML = signals.map(s => {
        const time = new Date(s.timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        const arrow = s.direction === 'UP' ? '\u2B06' : '\u2B07';
        const resultClass = s.outcome === 'WIN' ? 'result-win' : (s.outcome === 'LOSS' ? 'result-loss' : 'result-pending');
        const resultText = s.outcome || 'PENDING';

        const coinCell = s.slug
            ? `<a href="https://polymarket.com/event/${s.slug}" target="_blank" rel="noopener">${s.coin}</a>`
            : s.coin;

        return `<tr>
            <td>${time}</td>
            <td>${coinCell}</td>
            <td>${arrow} ${s.direction}</td>
            <td>$${(s.entry_price || 0).toFixed(2)}</td>
            <td class="${resultClass}">${resultText}</td>
        </tr>`;
    }).join('');
}

// Load on page load, refresh every 60 seconds
loadStats();
setInterval(loadStats, 60000);

// ==========================================================================
// PolyWeather -- Phase 4 stats (D-13)
// ==========================================================================

const PW_STATS_URL = 'polyweather-stats.json';
const PW_STRATEGY_KEY = 'pw_strategy_filter';  // localStorage key
let pwChart = null;
let _pwStatsData = null;  // last loaded stats, kept for re-renders on tab switch

// Returns the currently selected strategy filter: 'all' | 'tail_longshot' | 'modal_early'
function currentStrategy() {
    return localStorage.getItem(PW_STRATEGY_KEY) || 'all';
}

function setStrategy(strategy) {
    localStorage.setItem(PW_STRATEGY_KEY, strategy);
    // Update tab UI
    document.querySelectorAll('.strategy-tab').forEach(btn => {
        const isActive = btn.dataset.strategy === strategy;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    // Toggle bankroll-mode on body so CSS swaps the bankroll <-> cities card
    document.body.classList.toggle('strategy-mode', strategy !== 'all');
    // Re-render everything that depends on strategy filter
    if (_pwStatsData) {
        renderPolyWeatherStats(_pwStatsData);
        renderPolyWeatherChart(_pwStatsData.daily_pnl || []);
        renderPolyWeatherTrades(_pwStatsData.recent_trades || []);
    }
    if (_pwLifecycleData) renderLifecycle();
}

async function loadPolyWeather() {
    try {
        const resp = await fetch(PW_STATS_URL, { cache: 'no-cache' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const stats = await resp.json();
        _pwStatsData = stats;
        updateTabCounts(stats);
        renderPolyWeatherStats(stats);
        renderPolyWeatherChart(stats.daily_pnl || []);
        renderPolyWeatherTrades(stats.recent_trades || []);
    } catch (err) {
        console.warn('Failed to load polyweather stats:', err);
        const el = document.getElementById('pw-updated');
        if (el) el.textContent = 'Stats unavailable -- check back soon';
    }
}

// Paints the bet-count badges inside each tab.
// "All strategies" sums the per-strategy bets (NOT stats.trade_count) so the
// "All" badge equals Tail + Modal — otherwise FANTASY-filtered fills cause
// the All badge to exceed the sum of strategy badges, which is confusing.
function updateTabCounts(stats) {
    const strat = stats.strategies || {};
    const tailBets = (strat.tail_longshot && strat.tail_longshot.bets) || 0;
    const modalBets = (strat.modal_early && strat.modal_early.bets) || 0;
    const counts = {
        all: tailBets + modalBets,
        tail_longshot: tailBets,
        modal_early: modalBets,
    };
    document.querySelectorAll('.strategy-tab').forEach(btn => {
        const key = btn.dataset.strategy;
        const metaEl = btn.querySelector('[data-role="bets"]');
        if (metaEl) metaEl.textContent = counts[key] != null ? counts[key] : '—';
    });
}

function renderPolyWeatherStats(stats) {
    const strat = currentStrategy();
    const isAll = strat === 'all';
    const s = (stats.strategies || {})[strat] || null;

    // "Paper trades" shows TOTAL bets (pending + resolved) so the count here
    // matches the tab badge. Hit rate uses only RESOLVED bets as denominator
    // since pending bets don't have an outcome yet. Summed from the strategies
    // block (NOT stats.trade_count) so aggregate matches Tail + Modal exactly.
    const allStrats = Object.values(stats.strategies || {});
    const totalBets = isAll
        ? allStrats.reduce((n, v) => n + (v.bets || 0), 0)
        : (s ? s.bets : 0);
    const resolvedBets = isAll
        ? allStrats.reduce((n, v) => n + (v.resolved || 0), 0)
        : (s ? (s.resolved || 0) : 0);
    const wins = isAll
        ? allStrats.reduce((n, v) => n + (v.wins || 0), 0)
        : (s ? s.wins : 0);
    const hitRate = resolvedBets > 0 ? (wins / resolvedBets) * 100 : 0;
    const pnl = isAll
        ? allStrats.reduce((n, v) => n + (v.pnl_usd || 0), 0)
        : (s ? s.pnl_usd : 0);

    document.getElementById('pw-hit-rate').textContent = hitRate.toFixed(1) + '%';

    const pnlEl = document.getElementById('pw-pnl');
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    pnlEl.style.color = pnl >= 0 ? 'var(--win)' : 'var(--loss)';

    // Show "resolved / total" — e.g. "1 / 14" — so we know how much of the
    // sample is decided vs still open.
    document.getElementById('pw-trades').textContent =
        totalBets > 0 ? `${resolvedBets} / ${totalBets}` : '0';

    if (isAll) {
        document.getElementById('pw-cities').textContent = stats.active_cities || 0;
    } else if (s && s.bankroll) {
        const br = s.bankroll;
        const valEl  = document.getElementById('pw-bankroll-value');
        const lblEl  = document.getElementById('pw-bankroll-label');
        const fillEl = document.getElementById('pw-bankroll-fill');
        const pct = br.start > 0 ? Math.max(0, Math.min(1, br.current / br.start)) : 0;
        valEl.textContent = '$' + (br.current || 0).toFixed(2);
        valEl.style.color = pct > 0.5 ? 'var(--win)' : (pct > 0.2 ? '#f0b050' : 'var(--loss)');
        lblEl.textContent = 'Bankroll (of $' + (br.start || 0).toFixed(0) +
            (br.daily_loss > 0 ? ' · today −$' + br.daily_loss.toFixed(2) : '') + ')';
        fillEl.style.width = (pct * 100).toFixed(1) + '%';
        fillEl.classList.toggle('is-warn',   pct <= 0.5 && pct > 0.2);
        fillEl.classList.toggle('is-danger', pct <= 0.2);
    }

    if (stats.updated_at) {
        const d = new Date(stats.updated_at);
        document.getElementById('pw-updated').textContent =
            'Updated: ' + d.toLocaleString();
    }
}

function renderPolyWeatherChart(dailyPnl) {
    const canvas = document.getElementById('pw-pnl-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    const labels = dailyPnl.map(d => d.date);
    const data = dailyPnl.map(d => d.cumulative_pnl);
    const cfg = {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Cumulative P&L (USDC)',
                data: data,
                borderColor: '#22c55e',
                backgroundColor: 'rgba(34, 197, 94, 0.15)',
                fill: true,
                tension: 0.25,
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { labels: { color: '#e5e7eb' } } },
            scales: {
                x: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } },
                y: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } }
            }
        }
    };
    if (pwChart) { pwChart.destroy(); }
    pwChart = new Chart(canvas, cfg);
}

function renderPolyWeatherTrades(trades) {
    const tbody = document.getElementById('pw-trades-body');
    if (!tbody) return;

    // Filter by current strategy tab (trades without strategy field fall through as tail_longshot)
    const strat = currentStrategy();
    const filtered = strat === 'all'
        ? trades
        : trades.filter(t => (t.strategy || 'tail_longshot') === strat);

    if (!filtered.length) {
        const msg = strat === 'all'
            ? 'No paper trades yet -- bot is warming up'
            : `No ${strat.replace('_', ' ')} trades yet`;
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-dim)">${msg}</td></tr>`;
        return;
    }
    trades = filtered;
    tbody.innerHTML = trades.map(t => {
        const time = new Date(t.logged_at).toLocaleString([], {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
        const outcome = (t.outcome || 'PENDING').toUpperCase();
        const cls = outcome === 'WIN'  ? 'result-win'
                  : outcome === 'LOSS' ? 'result-loss'
                  : 'result-pending';
        const edgePct = ((t.edge || 0) * 100).toFixed(1) + '%';
        const size = '$' + (t.kelly_size_usdc || 0).toFixed(2);

        // If the row has a market_slug, wrap the time + bracket cells in a
        // link to the Polymarket market. Matches the lifecycle timeline's
        // row-label linking pattern.
        const url = t.market_slug
            ? `https://polymarket.com/market/${encodeURIComponent(t.market_slug)}`
            : null;
        const timeCell = url
            ? `<td><a href="${url}" target="_blank" rel="noopener">${time}</a></td>`
            : `<td>${time}</td>`;
        const bracketCell = url
            ? `<td><a href="${url}" target="_blank" rel="noopener"><code>${t.bracket}</code></a></td>`
            : `<td><code>${t.bracket}</code></td>`;

        return `<tr>
            ${timeCell}
            <td>${t.city}</td>
            ${bracketCell}
            <td>${edgePct}</td>
            <td>${size}</td>
            <td class="${cls}">${outcome}</td>
        </tr>`;
    }).join('');
}

// Extend the existing cadence: load on init and refresh every 60s alongside PolySniper.
loadPolyWeather();
setInterval(loadPolyWeather, 60000);

// ---------- PolyWeather Lifecycle Timeline ----------

const PW_LIFECYCLE_URL = 'polyweather-lifecycle.json';
const PW_LC_REFRESH_MS = 60_000;
let _pwLifecycleData = null;

async function loadPolyWeatherLifecycle() {
    try {
        const resp = await fetch(PW_LIFECYCLE_URL, { cache: 'no-cache' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        _pwLifecycleData = data;
        populateCityFilter(data.markets);
        renderLifecycle();
    } catch (err) {
        console.warn('Failed to load polyweather lifecycle:', err);
        const el = document.getElementById('pw-lc-updated');
        if (el) el.textContent = 'Lifecycle unavailable -- check back soon';
    }
}

function populateCityFilter(markets) {
    const sel = document.getElementById('pw-lc-city');
    const current = sel.value;
    const cities = [...new Set(markets.map(m => m.city))].sort();
    sel.innerHTML = '<option value="">All</option>' +
        cities.map(c => `<option value="${c}">${c}</option>`).join('');
    sel.value = current;
}

function renderLifecycle() {
    if (!_pwLifecycleData) return;
    const { markets, now, updated_at } = _pwLifecycleData;
    const nowMs = Date.parse(now);

    const cityFilter = document.getElementById('pw-lc-city').value;
    const typeFilter = document.getElementById('pw-lc-type').value;
    const stateFilter = document.getElementById('pw-lc-state').value;
    const strat = currentStrategy();

    // Market-level filters first (city/type/state), then strategy filter on bets.
    // When a specific strategy is selected, markets with zero matching bets are
    // hidden — otherwise the timeline looks identical across tabs, which makes
    // the filter feel broken.
    const visible = markets.map(m => {
        if (cityFilter && m.city !== cityFilter) return null;
        if (typeFilter && m.market_type !== typeFilter) return null;
        if (stateFilter && m.state !== stateFilter) return null;

        if (strat === 'all') return m;

        const filteredBets = (m.bets || []).filter(b => (b.strategy || 'tail_longshot') === strat);
        if (filteredBets.length === 0) return null;  // strict: only markets with matching bets
        return { ...m, bets: filteredBets };
    }).filter(m => m !== null);

    // Cluster by city, sorted by soonest pending close. Cities with any
    // pending market come first (ordered by earliest pending effective_close);
    // fully-resolved cities sink to the bottom (ordered by their overall
    // earliest close). Within a city: HIGH before LOW, then bracket numeric.
    const cityKey = {};
    for (const m of visible) {
        const k = m.effective_close_time || m.market_end_date || '';
        const isPending = !(m.outcome);
        if (!cityKey[m.city]) cityKey[m.city] = { pendingKey: null, anyKey: k };
        const ck = cityKey[m.city];
        if (isPending && (ck.pendingKey === null || k < ck.pendingKey)) ck.pendingKey = k;
        if (!ck.anyKey || k < ck.anyKey) ck.anyKey = k;
    }
    visible.sort((a, b) => {
        const aCk = cityKey[a.city], bCk = cityKey[b.city];
        // 1. Cities with any pending markets come before fully-resolved cities
        const aPend = aCk.pendingKey !== null, bPend = bCk.pendingKey !== null;
        if (aPend !== bPend) return aPend ? -1 : 1;
        // 2. Sort cities by their key (soonest first)
        const aSortKey = aPend ? aCk.pendingKey : aCk.anyKey;
        const bSortKey = bPend ? bCk.pendingKey : bCk.anyKey;
        const keyCmp = aSortKey.localeCompare(bSortKey);
        if (keyCmp !== 0) return keyCmp;
        // 3. Same key, different city → alphabetical tiebreak
        if (a.city !== b.city) return a.city.localeCompare(b.city);
        // 4. Same city → HIGH before LOW
        if (a.market_type !== b.market_type) return a.market_type === 'high' ? -1 : 1;
        // 5. Same city+type → bracket numeric (exact 14 < exact 15)
        const aNum = parseFloat((a.bracket || '').replace(/[^\d.\-]/g, ''));
        const bNum = parseFloat((b.bracket || '').replace(/[^\d.\-]/g, ''));
        if (!isNaN(aNum) && !isNaN(bNum) && aNum !== bNum) return aNum - bNum;
        // 6. Final tiebreak: effective_close
        const aKey = a.effective_close_time || a.market_end_date || '';
        const bKey = b.effective_close_time || b.market_end_date || '';
        return aKey.localeCompare(bKey);
    });

    const betCount = visible.reduce((s, m) => s + m.bets.length, 0);
    document.getElementById('pw-lc-summary').textContent =
        visible.length + ' markets • ' + betCount + ' bets';
    document.getElementById('pw-lc-updated').textContent =
        'Updated ' + new Date(updated_at).toLocaleTimeString() + ' • auto-refresh 60s';

    drawLifecycleSvg(visible, nowMs);
}

function drawLifecycleSvg(markets, nowMs) {
    const svg = document.getElementById('pw-lc-svg');
    const MARGIN_LEFT = 210;
    const MARGIN_RIGHT = 20;
    const MARGIN_TOP = 30;
    const ROW_H = 22;
    const CITY_HEADER_H = 8;  // extra vertical gap between city groups
    // Precompute per-row y offset accounting for city-group spacing.
    const rowYOffsets = [];
    let cumExtra = 0;
    markets.forEach((m, i) => {
        if (i > 0 && markets[i].city !== markets[i - 1].city) cumExtra += CITY_HEADER_H;
        rowYOffsets.push(MARGIN_TOP + i * ROW_H + cumExtra);
    });
    const rowCount = Math.max(markets.length, 1);
    const height = MARGIN_TOP + rowCount * ROW_H + cumExtra + 30;
    svg.setAttribute('height', height);

    const totalWidth = svg.getBoundingClientRect().width || svg.clientWidth || 900;
    const chartW = totalWidth - MARGIN_LEFT - MARGIN_RIGHT;

    const times = [];
    for (const m of markets) {
        if (m.game_start_time) times.push(Date.parse(m.game_start_time));
        if (m.effective_close_time) times.push(Date.parse(m.effective_close_time));
        if (m.resolved_at) times.push(Date.parse(m.resolved_at));
        for (const b of m.bets) if (b.placed_at) times.push(Date.parse(b.placed_at));
    }
    if (times.length === 0) { svg.innerHTML = ''; return; }

    const tMin = Math.min(...times);
    const tMax = Math.max(...times, nowMs);
    const tSpan = tMax - tMin || 1;
    const xOf = (ts) => MARGIN_LEFT + ((ts - tMin) / tSpan) * chartW;

    const parts = [];

    // Time axis (4 ticks)
    for (let i = 0; i <= 4; i++) {
        const t = tMin + (tSpan * i / 4);
        const x = xOf(t).toFixed(1);
        const lbl = new Date(t).toISOString().replace('T', ' ').substring(5, 16) + 'Z';
        parts.push(`<line x1="${x}" y1="${MARGIN_TOP - 10}" x2="${x}" y2="${height - 20}" stroke="#2a2a3a" stroke-dasharray="2,4"/>`);
        parts.push(`<text x="${x}" y="${height - 4}" text-anchor="middle" font-size="9" fill="#666">${lbl}</text>`);
    }

    // Now line
    const nowX = xOf(nowMs);
    if (nowX >= MARGIN_LEFT && nowX <= totalWidth - MARGIN_RIGHT) {
        parts.push(`<line x1="${nowX.toFixed(1)}" y1="${MARGIN_TOP - 15}" x2="${nowX.toFixed(1)}" y2="${height - 20}" stroke="var(--accent)" stroke-width="2"/>`);
        parts.push(`<text x="${nowX.toFixed(1)}" y="${MARGIN_TOP - 18}" text-anchor="middle" font-size="9" fill="var(--accent)">NOW</text>`);
    }

    // Per-market rows
    markets.forEach((m, i) => {
        const y = rowYOffsets[i];
        const rowMid = y + ROW_H / 2;

        // City-group separator line above first row of each city
        const isFirstOfCity = i === 0 || markets[i - 1].city !== m.city;
        if (isFirstOfCity && i > 0) {
            const sepY = y - CITY_HEADER_H / 2;
            parts.push(`<line x1="0" y1="${sepY.toFixed(1)}" x2="${totalWidth}" y2="${sepY.toFixed(1)}" stroke="#2a2a3a" stroke-width="1"/>`);
        }

        // Label format: "City ↑/↓ bracket · Apr DD"
        const typeSymbol = m.market_type === 'low' ? '↓' : '↑';
        const resDate = (m.resolution_date || '').substring(5);  // "04-23" from "2026-04-23"
        const cityAbbrev = {
            'New York City': 'NYC',
            'Hong Kong': 'HK',
            'Sao Paulo': 'SP',
        };
        const cityShort = cityAbbrev[m.city]
            || (m.city.length > 12 ? m.city.substring(0, 11) + '…' : m.city);
        const label = `${cityShort} ${typeSymbol} ${m.bracket} · ${resDate}`;
        if (m.market_slug) {
            const url = 'https://polymarket.com/market/' + encodeURIComponent(m.market_slug);
            parts.push(`<a href="${url}" target="_blank" rel="noopener"><text x="${MARGIN_LEFT - 6}" y="${(rowMid + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--accent)" style="cursor:pointer;text-decoration:underline">${escapeXml(label)}</text></a>`);
        } else {
            parts.push(`<text x="${MARGIN_LEFT - 6}" y="${(rowMid + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#bbb">${escapeXml(label)}</text>`);
        }

        // "Legacy" state indicator: if game_start_time missing, dashed outline on full row
        if (m.state === 'legacy') {
            parts.push(`<rect x="${MARGIN_LEFT}" y="${(y + 4).toFixed(1)}" width="${(totalWidth - MARGIN_LEFT - MARGIN_RIGHT).toFixed(1)}" height="${ROW_H - 8}" fill="none" stroke="#555" stroke-dasharray="3,3" opacity="0.4"/>`);
        }

        const gst = m.game_start_time ? Date.parse(m.game_start_time) : null;
        const lpt = m.last_placement_time ? Date.parse(m.last_placement_time) : null;
        const efc = m.effective_close_time ? Date.parse(m.effective_close_time) : null;
        const resolvedAt = m.resolved_at ? Date.parse(m.resolved_at) : null;

        // Trading segment: game_start → last_placement
        if (gst !== null && lpt !== null) {
            const x0 = xOf(gst), x1 = xOf(lpt);
            if (x1 > x0) parts.push(`<rect x="${x0.toFixed(1)}" y="${y + 6}" width="${(x1 - x0).toFixed(1)}" height="${ROW_H - 12}" fill="var(--legend-trading)" opacity="0.65" rx="2"/>`);
        }
        // Post-placement segment: last_placement → effective_close
        if (lpt !== null && efc !== null) {
            const x0 = xOf(lpt), x1 = xOf(efc);
            if (x1 > x0) parts.push(`<rect x="${x0.toFixed(1)}" y="${y + 6}" width="${(x1 - x0).toFixed(1)}" height="${ROW_H - 12}" fill="var(--legend-post)" opacity="0.65" rx="2"/>`);
        }
        // Closed/awaiting segment: effective_close → resolved_at (or now)
        if (efc !== null) {
            const closedEnd = resolvedAt !== null ? resolvedAt : nowMs;
            if (closedEnd > efc) {
                const x0 = xOf(efc), x1 = xOf(closedEnd);
                if (x1 > x0) parts.push(`<rect x="${x0.toFixed(1)}" y="${y + 6}" width="${(x1 - x0).toFixed(1)}" height="${ROW_H - 12}" fill="var(--legend-closed)" opacity="0.65" rx="2"/>`);
            }
        }

        // Resolution dot (circle at resolved_at)
        if (resolvedAt !== null) {
            const cx = xOf(resolvedAt).toFixed(1);
            const fill = m.outcome === 'win' ? 'var(--legend-won)' : 'var(--legend-lost)';
            parts.push(`<circle cx="${cx}" cy="${rowMid}" r="5" fill="${fill}" stroke="#0a0a0f" stroke-width="1.5"/>`);
        }

        // Bet markers
        for (const b of m.bets) {
            if (!b.placed_at) continue;
            const bx = xOf(Date.parse(b.placed_at)).toFixed(1);
            const fill = b.outcome === 'win' ? 'var(--legend-won)' :
                b.outcome === 'loss' ? 'var(--legend-lost)' : 'var(--legend-bet)';
            const pnlStr = b.realized_pnl_usd != null
                ? ' pnl=$' + b.realized_pnl_usd.toFixed(2) : '';
            const tip = m.city + ' ' + m.bracket + ' | ' +
                b.placed_at.substring(0, 16) + ' | $' +
                (b.size_usd || 0).toFixed(2) + ' | p=' +
                (b.model_prob || 0).toFixed(3) + ' | ' +
                (b.outcome || 'pending') + pnlStr;
            parts.push(`<circle cx="${bx}" cy="${rowMid}" r="3.5" fill="${fill}" stroke="#0a0a0f" stroke-width="0.5"><title>${escapeXml(tip)}</title></circle>`);
        }
    });

    svg.innerHTML = parts.join('\n');
}

function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Mirror top-level loadStats() / loadPolyWeather() pattern (script runs after DOM)
loadPolyWeatherLifecycle();
setInterval(loadPolyWeatherLifecycle, PW_LC_REFRESH_MS);
window.addEventListener('resize', renderLifecycle);
['pw-lc-city', 'pw-lc-type', 'pw-lc-state'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderLifecycle);
});

// Restore strategy tab from localStorage and wire click handlers
(function initStrategyTabs() {
    const saved = currentStrategy();
    setStrategy(saved);  // paint initial UI state
    document.querySelectorAll('.strategy-tab').forEach(btn => {
        btn.addEventListener('click', () => setStrategy(btn.dataset.strategy));
    });
})();
