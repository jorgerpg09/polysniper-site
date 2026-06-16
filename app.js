// PolySniper — Fetch stats and render performance data
// Paper/Live split: paper (dry-run, VPS) -> stats.json; live (Mac, real CLOB
// orders) -> stats-live.json. Mirrors the PolyWeather paper/live toggle.

const CS_SOURCES = { paper: 'stats.json', live: 'stats-live.json' };
const CS_SOURCE_KEY = 'cs_data_source';  // localStorage key

function cryptoSource() {
    return localStorage.getItem(CS_SOURCE_KEY) || 'paper';
}

function setCryptoSource(source) {
    localStorage.setItem(CS_SOURCE_KEY, source);
    document.querySelectorAll('.cs-source-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.csSource === source);
    });
    const tag = document.getElementById('cs-source-tagline');
    if (tag) {
        tag.textContent = source === 'live'
            ? 'LIVE — real CLOB orders from Mac, real P&L. Bets also visible on Polymarket.'
            : 'Paper / dry-run — simulated fills, no real money.';
    }
    loadStats();
}

async function loadStats() {
    const url = CS_SOURCES[cryptoSource()] || 'stats.json';
    try {
        const resp = await fetch(url, { cache: 'no-cache' });
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
document.querySelectorAll('.cs-source-btn').forEach(btn => {
    btn.addEventListener('click', () => setCryptoSource(btn.dataset.csSource));
});
setCryptoSource(cryptoSource());  // apply persisted source, sets button state + loads
setInterval(loadStats, 60000);

// ==========================================================================
// PolyWeather -- Phase 4 stats (D-13)
// ==========================================================================

const PW_SOURCES = {
    paper: { stats: 'polyweather-stats.json', lifecycle: 'polyweather-lifecycle.json' },
    live:  { stats: 'polyweather-live-stats.json', lifecycle: 'polyweather-live-lifecycle.json' },
};
const PW_SOURCE_KEY = 'pw_data_source';  // localStorage key
const PW_STRATEGY_KEY = 'pw_strategy_filter';  // localStorage key
const PW_POSTFIX_ONLY_KEY = 'pw_postfix_only';  // localStorage key for boundary toggle
let pwChart = null;
let _pwStatsData = null;  // last loaded stats, kept for re-renders on tab switch

function currentSource() {
    return localStorage.getItem(PW_SOURCE_KEY) || 'paper';
}
function setSource(source) {
    localStorage.setItem(PW_SOURCE_KEY, source);
    document.querySelectorAll('.pw-source-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.source === source);
    });
    const tagline = document.getElementById('pw-source-tagline');
    if (tagline) {
        tagline.textContent = source === 'live'
            ? 'Live trading from Mac. Real CLOB orders on No-side between brackets.'
            : 'Paper-trading to validate the edge before deploying real capital.';
    }
    applySourceTabVisibility();
    loadPolyWeather();
    loadPolyWeatherLifecycle();
}

// All currently-displayed strategies (tail_longshot archived 2026-04-25, hidden 2026-04-28).
// Order matches the index.html tab order so updateTabCounts can iterate consistently.
// 2026-05-31 (quick 260531-nj5): the dead "diagnostic battery" strategies
// (raw_forecast_*, adjacency*, below_tail, consensus_*, tail_longshot) were
// removed from PolyWeather's active code path. They no longer have active
// tabs here — but the exporter JSON still contains their historical stats, so
// they're rendered under a collapsed "Archived" grouping (PW_LEGACY_STRATEGIES)
// to keep the history viewable.
const PW_STRATEGIES = ['modal_early', 'no_between', 'no_between_live', 'no_above', 'no_below', 'no_exact', 'no_exact_live', 'conviction_yes', 'conviction_no'];

// Dead/legacy strategies. No active tab — shown only under the collapsed
// "Archived" grouping so their historical stats (still in the JSON) stay
// viewable. Never counted toward the "All" badge.
const PW_LEGACY_STRATEGIES = ['tail_longshot', 'raw_forecast_corrected', 'raw_forecast_raw', 'adjacency', 'adjacency_capped', 'adjacency_hourly', 'below_tail', 'consensus_fires', 'consensus_models'];

// Every strategy key the UI can render a panel for (active + archived).
const PW_ALL_STRATEGIES = PW_STRATEGIES.concat(PW_LEGACY_STRATEGIES);

// Strategies that actually place real CLOB orders. Live tab hides everything
// else so the user isn't misled by paper-only counters that the exporter
// still writes into polyweather-live-stats.json (the Mac scheduler runs the
// full strategy battery). As of 2026-05-25, no_between and no_exact both
// place live orders, dashboarded as no_between_live and no_exact_live.
// Promote others here as they go live.
const PW_LIVE_STRATEGIES = ['no_between_live', 'no_exact_live'];

// Returns the list of strategy keys that should be VISIBLE for the current
// data source. Paper shows everything; Live shows only PW_LIVE_STRATEGIES.
function visibleStrategiesForSource() {
    return currentSource() === 'live' ? PW_LIVE_STRATEGIES : PW_STRATEGIES;
}

// Show/hide strategy tabs based on the current data source. Called whenever
// the source switches and on initial load.
function applySourceTabVisibility() {
    const visible = new Set(visibleStrategiesForSource());
    const legacy = new Set(PW_LEGACY_STRATEGIES);
    document.querySelectorAll('.strategy-tab').forEach(btn => {
        const key = btn.dataset.strategy;
        if (key === 'all') return;  // 'all' always shown
        // Archived/legacy tabs live inside the collapsible "Archived" group
        // (controlled by that <details> element), so leave their display alone
        // here — the source toggle only governs the active tab row.
        if (legacy.has(key)) return;
        btn.style.display = visible.has(key) ? '' : 'none';
    });
    // If currently-selected ACTIVE strategy got hidden, fall back to 'all'.
    // Archived selections are valid (their data still renders), so don't reset.
    const cur = currentStrategy();
    if (cur !== 'all' && !legacy.has(cur) && !visible.has(cur)) {
        setStrategy('all');
    }
}

// Returns the currently selected strategy filter ('all' | any active key |
// any archived key). Archived/legacy keys (e.g. 'tail_longshot') are valid
// selections again as of 2026-05-31 — they render historical stats under the
// collapsed "Archived" grouping.
function currentStrategy() {
    return localStorage.getItem(PW_STRATEGY_KEY) || 'all';
}

// Returns whether the "post-fix only" toggle is on (default ON — hide pre-fix
// legacy bets so go/no-go reads aren't dragged down by zombie 'floor'-era °C
// positions). Persisted in localStorage. Set 2026-04-25 with the boundary fix.
function postfixOnly() {
    const v = localStorage.getItem(PW_POSTFIX_ONLY_KEY);
    return v === null ? true : v === 'true';
}
function setPostfixOnly(on) {
    localStorage.setItem(PW_POSTFIX_ONLY_KEY, on ? 'true' : 'false');
    if (_pwStatsData) {
        renderPolyWeatherStats(_pwStatsData);
        renderLiveWallet(_pwStatsData);
        renderPolyWeatherChart(_pwStatsData.daily_pnl || []);
        renderPolyWeatherTrades(_pwStatsData.recent_trades || []);
        updateTabCounts(_pwStatsData);
    }
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
        renderLiveWallet(_pwStatsData);
        renderPolyWeatherChart(_pwStatsData.daily_pnl || []);
        renderPolyWeatherTrades(_pwStatsData.recent_trades || []);
    }
    if (_pwLifecycleData) renderLifecycle();
}

async function loadPolyWeather() {
    const url = PW_SOURCES[currentSource()].stats;
    try {
        const resp = await fetch(url, { cache: 'no-cache' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const stats = await resp.json();
        _pwStatsData = stats;
        updateTabCounts(stats);
        renderPolyWeatherStats(stats);
        renderLiveWallet(stats);
        renderPolyWeatherChart(stats.daily_pnl || []);
        renderPolyWeatherTrades(stats.recent_trades || []);
    } catch (err) {
        console.warn('Failed to load polyweather stats:', err);
        const el = document.getElementById('pw-updated');
        if (el) el.textContent = currentSource() === 'live'
            ? 'Live stats not available yet -- Mac exporter not running'
            : 'Stats unavailable -- check back soon';
    }
}

// Pulls bet count for a strategy honoring the post-fix-only toggle.
// When the exporter has a `by_boundary` block, prefers that for accurate
// pre/post split. Falls back to flat `bets` if exporter is older.
function _pwStrategyBets(strat, postOnly) {
    if (!strat) return 0;
    if (postOnly && strat.by_boundary && strat.by_boundary.round) {
        return strat.by_boundary.round.bets || 0;
    }
    return strat.bets || 0;
}

// Paints the bet-count badges inside each tab.
// "All strategies" sums the per-strategy bets (NOT stats.trade_count) so the
// "All" badge equals the sum of visible strategy badges — otherwise FANTASY-
// filtered fills cause the All badge to exceed the sum, which is confusing.
function updateTabCounts(stats) {
    const strat = stats.strategies || {};
    const postOnly = postfixOnly();
    const visible = new Set(visibleStrategiesForSource());
    const counts = { all: 0 };
    // Iterate active + archived so archived tabs also get their bet badges.
    for (const key of PW_ALL_STRATEGIES) {
        const n = _pwStrategyBets(strat[key], postOnly);
        counts[key] = n;
        // "All" badge only sums VISIBLE ACTIVE strategies — archived/legacy
        // strategies never count toward it. On Live tab this further narrows
        // to live-eligible strategies, matching what the user can see.
        if (visible.has(key)) counts.all += n;
    }
    document.querySelectorAll('.strategy-tab').forEach(btn => {
        const key = btn.dataset.strategy;
        const metaEl = btn.querySelector('[data-role="bets"]');
        if (metaEl) metaEl.textContent = counts[key] != null ? counts[key] : '—';
    });

    // Update boundary-filter meta: "(N legacy bets hidden)" when toggle is on.
    // Sum across all CURRENTLY-DISPLAYED strategies. Legacy tail_longshot rows
    // still in the data file are NOT counted here — UI only reflects active.
    const metaEl = document.getElementById('pw-postfix-meta');
    if (metaEl) {
        let totalFloor = 0;
        for (const k of PW_STRATEGIES) {
            const s = strat[k];
            if (s && s.by_boundary && s.by_boundary.floor) {
                totalFloor += s.by_boundary.floor.bets || 0;
            }
        }
        if (postOnly && totalFloor > 0) {
            metaEl.textContent = `(${totalFloor} legacy hidden)`;
        } else if (!postOnly && totalFloor > 0) {
            metaEl.textContent = `(${totalFloor} legacy shown)`;
        } else {
            metaEl.textContent = '';
        }
    }
}

function renderPolyWeatherStats(stats) {
    const strat = currentStrategy();
    const isAll = strat === 'all';
    const s = (stats.strategies || {})[strat] || null;
    const postOnly = postfixOnly();

    // Resolve metrics for one strategy entry, honoring the post-fix-only toggle.
    // Falls back to flat fields when by_boundary block isn't present (older
    // exporter JSON before 2026-04-25).
    function pick(entry) {
        if (!entry) return { bets: 0, resolved: 0, wins: 0, pnl_usd: 0 };
        if (postOnly && entry.by_boundary && entry.by_boundary.round) {
            return entry.by_boundary.round;
        }
        return entry;
    }

    // "Paper trades" shows TOTAL bets (pending + resolved) so the count here
    // matches the tab badge. Hit rate uses only RESOLVED bets as denominator
    // since pending bets don't have an outcome yet. Summed from the strategies
    // block (NOT stats.trade_count) so aggregate matches Tail + Modal exactly.
    // On Live tab, restrict the "All" aggregate to live-eligible strategies so
    // headline metrics aren't polluted by paper-only counters present in the
    // live stats JSON (Mac scheduler runs the full battery; only no_between
    // actually places real CLOB orders).
    const visibleKeys = new Set(visibleStrategiesForSource());
    const allStrats = Object.entries(stats.strategies || {})
        .filter(([k, _]) => visibleKeys.has(k))
        .map(([_, v]) => pick(v));
    const sPick = pick(s);
    const totalBets = isAll
        ? allStrats.reduce((n, v) => n + (v.bets || 0), 0)
        : (sPick.bets || 0);
    const resolvedBets = isAll
        ? allStrats.reduce((n, v) => n + (v.resolved || 0), 0)
        : (sPick.resolved || 0);
    const wins = isAll
        ? allStrats.reduce((n, v) => n + (v.wins || 0), 0)
        : (sPick.wins || 0);
    const hitRate = resolvedBets > 0 ? (wins / resolvedBets) * 100 : 0;
    const pnl = isAll
        ? allStrats.reduce((n, v) => n + (v.pnl_usd || 0), 0)
        : (sPick.pnl_usd || 0);

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
        // Headline: AVAILABLE (current - open_stake) so you can see exposure.
        // Fall back to current if available is missing (pre-update exporter).
        const available = (br.available != null) ? br.available : (br.current || 0);
        const openStake = br.open_stake || 0;
        const pct = br.start > 0 ? Math.max(0, Math.min(1, available / br.start)) : 0;
        valEl.textContent = '$' + available.toFixed(2);
        valEl.style.color = pct > 0.5 ? 'var(--win)' : (pct > 0.2 ? '#f0b050' : 'var(--loss)');
        // Label shows: "of $X · open $Y · today -$Z" (omit zero parts)
        const parts = ['of $' + (br.start || 0).toFixed(0)];
        if (openStake > 0) parts.push('open $' + openStake.toFixed(2));
        if (br.daily_loss > 0) parts.push('today −$' + br.daily_loss.toFixed(2));
        lblEl.textContent = 'Bankroll (' + parts.join(' · ') + ')';
        fillEl.style.width = (pct * 100).toFixed(1) + '%';
        fillEl.classList.toggle('is-warn',   pct <= 0.5 && pct > 0.2);
        fillEl.classList.toggle('is-danger', pct <= 0.2);
    } else {
        // No data for this strategy yet (e.g. newly-enabled live tab before
        // first stats_exporter cycle). Reset the bankroll tile to a clean
        // default so we don't leave stale values from the previously-selected
        // tab (bug discovered 2026-05-25 when no_exact_live tab inherited
        // no_between_live's $93.18 bankroll while showing 0 bets / $0 PnL).
        const valEl  = document.getElementById('pw-bankroll-value');
        const lblEl  = document.getElementById('pw-bankroll-label');
        const fillEl = document.getElementById('pw-bankroll-fill');
        valEl.textContent = '$100.00';
        valEl.style.color = 'var(--win)';
        lblEl.textContent = 'Bankroll (of $100 · no bets yet)';
        fillEl.style.width = '100%';
        fillEl.classList.remove('is-warn', 'is-danger');
    }

    if (stats.updated_at) {
        const d = new Date(stats.updated_at);
        document.getElementById('pw-updated').textContent =
            'Updated: ' + d.toLocaleString();
    }
}

// Live wallet card — visible only on Live tab. Shows real on-chain USDC
// balance, capital currently deployed across PW_LIVE_STRATEGIES, and the
// available headroom. Both live strategies share the same Polymarket
// wallet, so this is a global state — not per-strategy.
function renderLiveWallet(stats) {
    const card = document.getElementById('pw-wallet-card');
    if (!card) return;

    if (currentSource() !== 'live') {
        card.style.display = 'none';
        return;
    }

    const wallet = stats.live_wallet_usdc;
    if (wallet == null) {
        // Field not populated yet (e.g. before first post-deploy site_exporter
        // cycle). Hide rather than show placeholder so the layout doesn't jump.
        card.style.display = 'none';
        return;
    }

    const strats = stats.strategies || {};
    let deployed = 0;
    for (const key of PW_LIVE_STRATEGIES) {
        const s = strats[key];
        if (s && s.bankroll && s.bankroll.open_stake) {
            deployed += s.bankroll.open_stake;
        }
    }
    const available = wallet - deployed;

    document.getElementById('pw-wallet-balance').textContent = '$' + wallet.toFixed(2);
    document.getElementById('pw-wallet-deployed').textContent = '$' + deployed.toFixed(2);
    document.getElementById('pw-wallet-available').textContent = '$' + available.toFixed(2);

    const updEl = document.getElementById('pw-wallet-updated');
    if (stats.live_wallet_at) {
        const d = new Date(stats.live_wallet_at);
        updEl.textContent = 'Wallet sampled: ' + d.toLocaleString();
    } else {
        updEl.textContent = '';
    }

    card.style.display = 'block';
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

    // Filter by current strategy tab. Trades without a strategy field are legacy
    // tail_longshot — when "all" is selected we exclude them from the displayed
    // table (tail was archived 2026-04-25 and removed from UI 2026-04-28). When
    // a specific strategy tab is selected, only exact matches show.
    // On Live tab, "all" further restricts to live-eligible strategies so paper
    // rows don't show up under live (the live stats JSON contains both).
    const strat = currentStrategy();
    const visibleKeys = new Set(visibleStrategiesForSource());
    let filtered = strat === 'all'
        ? trades.filter(t => t.strategy && t.strategy !== 'tail_longshot' && visibleKeys.has(t.strategy))
        : trades.filter(t => t.strategy === strat);

    // Boundary-convention filter: when post-fix-only is on, hide legacy 'floor'
    // rows. Rows without the field (older exporter JSON) treated as 'floor'
    // → hidden when toggle on. Conservative: better to under-show than over-show.
    const postOnly = postfixOnly();
    if (postOnly) {
        filtered = filtered.filter(t => (t.boundary_convention || 'floor') === 'round');
    }

    if (!filtered.length) {
        const msg = strat === 'all'
            ? (postOnly ? 'No post-fix paper trades yet — first ones land after the next forecast cron'
                        : 'No paper trades yet -- bot is warming up')
            : `No ${strat.replace('_', ' ')} trades yet`;
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim)">${msg}</td></tr>`;
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
        const size = '$' + (t.kelly_size_usdc || 0).toFixed(2);

        // Model vs Market probabilities at bet time.
        // Fallback: if new fields missing (pre-exporter-update JSON),
        // derive from edge where possible — otherwise show "—".
        const hasProbs = t.model_prob != null && t.market_ask != null;
        const modelPct = hasProbs ? (t.model_prob * 100).toFixed(0) + '%'  : '—';
        const marketPct = hasProbs ? (t.market_ask * 100).toFixed(0) + '%' : '—';
        const edgePP = hasProbs
            ? ((t.model_prob - t.market_ask) * 100).toFixed(1)
            : ((t.edge || 0) * 100).toFixed(1);
        const edgeBadge = hasProbs
            ? ` <span class="edge-pp">(+${edgePP}pp)</span>`
            : ` <span class="edge-pp">${edgePP}pp</span>`;

        // Merged Market cell — mirrors the Market Lifecycle row label format
        // ("City ↑/↓ bracket · MM-DD") so users can match a trade row to its
        // lifecycle bar by eye. Same city abbreviations + symbol convention.
        const cityAbbrev = {
            'New York City': 'NYC',
            'Hong Kong': 'HK',
            'Sao Paulo': 'SP',
        };
        const cityShort = cityAbbrev[t.city]
            || (t.city.length > 12 ? t.city.substring(0, 11) + '…' : t.city);
        // market_type may be missing on older JSON snapshots — default to '↑' (HIGH).
        const typeSymbol = t.market_type === 'low' ? '↓' : '↑';
        const resDateShort = (t.resolution_date || '').substring(5);  // "04-26" from "2026-04-26"
        const marketLabel = `${cityShort} ${typeSymbol} ${t.bracket} · ${resDateShort}`;

        const url = t.market_slug
            ? `https://polymarket.com/market/${encodeURIComponent(t.market_slug)}`
            : null;
        const marketCell = url
            ? `<td><a href="${url}" target="_blank" rel="noopener"><code>${marketLabel}</code></a></td>`
            : `<td><code>${marketLabel}</code></td>`;

        // Legacy badge: pre-fix bets keep showing when toggle is OFF; mark them.
        const isLegacy = (t.boundary_convention || 'floor') === 'floor';
        const legacyBadge = isLegacy
            ? ' <span class="row-prefix-badge" title="Placed before the 2026-04-25 boundary fix. Bracket likely 0.5°C off PM truth — most are zombie bets that will lose.">pre-fix</span>'
            : '';

        return `<tr>
            <td>${time}</td>
            ${marketCell}
            <td class="prob-cell">${modelPct} / ${marketPct}${edgeBadge}${legacyBadge}</td>
            <td>${size}</td>
            <td class="${cls}">${outcome}</td>
        </tr>`;
    }).join('');
}

// Extend the existing cadence: load on init and refresh every 60s alongside PolySniper.
loadPolyWeather();
setInterval(loadPolyWeather, 60000);

// ---------- PolyWeather Lifecycle Timeline ----------

const PW_LC_REFRESH_MS = 60_000;
let _pwLifecycleData = null;

async function loadPolyWeatherLifecycle() {
    const url = PW_SOURCES[currentSource()].lifecycle;
    try {
        const resp = await fetch(url, { cache: 'no-cache' });
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
    const hideOldResolved = document.getElementById('pw-lc-hide-old').checked;
    const strat = currentStrategy();

    // "Hide old resolved" cutoff: hide markets whose resolved_at is more than
    // 24h before now. Was previously based on resolution_date midnight, which
    // kept markets visible up to ~24h longer than intended. Switched to
    // resolved_at (the actual UMA resolution timestamp) for tighter control.
    // 2026-05-06: dropped from 1 day to 24h hard cutoff per user request.
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const oldCutoffMs = nowMs - ONE_DAY_MS;
    let hiddenOldCount = 0;

    // Market-level filters first (city/type/state), then strategy filter on bets.
    // When a specific strategy is selected, markets with zero matching bets are
    // hidden — otherwise the timeline looks identical across tabs, which makes
    // the filter feel broken.
    const visible = markets.map(m => {
        if (cityFilter && m.city !== cityFilter) return null;
        if (typeFilter && m.market_type !== typeFilter) return null;
        if (stateFilter && m.state !== stateFilter) return null;

        // Hide-old-resolved cutoff. Use resolved_at (actual UMA resolution
        // timestamp) and hide if it's older than 24h. Falls back to
        // resolution_date midnight if resolved_at missing (legacy data).
        if (hideOldResolved && m.state === 'resolved') {
            const refMs = m.resolved_at
                ? Date.parse(m.resolved_at)
                : (m.resolution_date ? Date.parse(m.resolution_date + 'T23:59:59Z') : null);
            if (Number.isFinite(refMs) && refMs < oldCutoffMs) {
                hiddenOldCount++;
                return null;
            }
        }

        // 'all' filters out legacy tail_longshot bets but keeps everything else.
        // On Live tab, also restrict to live-eligible strategies so the lifecycle
        // doesn't surface paper markets the user can't actually trade live.
        if (strat === 'all') {
            const liveVisible = new Set(visibleStrategiesForSource());
            const visibleBets = (m.bets || []).filter(b =>
                b.strategy
                && b.strategy !== 'tail_longshot'
                && liveVisible.has(b.strategy)
            );
            if (visibleBets.length === 0 && (m.bets || []).length > 0) return null;
            return { ...m, bets: visibleBets };
        }

        const filteredBets = (m.bets || []).filter(b => b.strategy === strat);
        if (filteredBets.length === 0) return null;  // strict: only markets with matching bets
        return { ...m, bets: filteredBets };
    }).filter(m => m !== null);

    // Stash for the summary line so renderLifecycle's footer can show "(N hidden)"
    _pwLifecycleData._hiddenOldCount = hiddenOldCount;

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
    const hidden = _pwLifecycleData._hiddenOldCount || 0;
    const summaryParts = [visible.length + ' markets', betCount + ' bets'];
    if (hidden > 0) summaryParts.push(hidden + ' old hidden');
    document.getElementById('pw-lc-summary').textContent = summaryParts.join(' • ');
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

    if (markets.length === 0) { svg.innerHTML = ''; return; }

    // 2026-05-06: fixed 48h window centered on NOW (was: dynamic min/max
    // computed from event timestamps, which made the chart span 36+ hours
    // and made trading-window zones invisibly small).
    // Left half: past 24h (recent fills + resolutions); right half: next 24h
    // (upcoming windows so we can see what's about to start trading).
    // Anything outside this window is clipped from the chart.
    const WINDOW_HALF_MS = 24 * 60 * 60 * 1000;
    const tMin = nowMs - WINDOW_HALF_MS;
    const tMax = nowMs + WINDOW_HALF_MS;
    const tSpan = tMax - tMin;
    const xOf = (ts) => MARGIN_LEFT + ((ts - tMin) / tSpan) * chartW;
    const xOfClipped = (ts) => Math.max(MARGIN_LEFT, Math.min(totalWidth - MARGIN_RIGHT, xOf(ts)));

    const parts = [];

    // Time axis: 7 ticks (every 8h on a 48h window). Format: "MM-DD HH:MM Z".
    for (let i = 0; i <= 6; i++) {
        const t = tMin + (tSpan * i / 6);
        const x = xOf(t).toFixed(1);
        const lbl = new Date(t).toISOString().replace('T', ' ').substring(5, 16) + 'Z';
        parts.push(`<line x1="${x}" y1="${MARGIN_TOP - 10}" x2="${x}" y2="${height - 20}" stroke="#2a2a3a" stroke-dasharray="2,4"/>`);
        parts.push(`<text x="${x}" y="${height - 4}" text-anchor="middle" font-size="9" fill="#666">${lbl}</text>`);
    }

    // Now line (always at center of chart now)
    const nowX = xOf(nowMs);
    parts.push(`<line x1="${nowX.toFixed(1)}" y1="${MARGIN_TOP - 15}" x2="${nowX.toFixed(1)}" y2="${height - 20}" stroke="var(--accent)" stroke-width="2"/>`);
    parts.push(`<text x="${nowX.toFixed(1)}" y="${MARGIN_TOP - 18}" text-anchor="middle" font-size="9" fill="var(--accent)">NOW</text>`);

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

        // Helper: draw zone bar segment, clipped to visible window. Skips if
        // segment is entirely outside [tMin, tMax].
        const drawZone = (t0, t1, fillVar) => {
            if (t0 === null || t1 === null || t1 <= t0) return;
            if (t1 < tMin || t0 > tMax) return;  // entirely outside window
            const x0 = xOfClipped(t0), x1 = xOfClipped(t1);
            if (x1 <= x0) return;
            parts.push(`<rect x="${x0.toFixed(1)}" y="${y + 6}" width="${(x1 - x0).toFixed(1)}" height="${ROW_H - 12}" fill="${fillVar}" opacity="0.65" rx="2"/>`);
        };

        // Three lifecycle zones (drawn for ALL strategies — ensures the zone
        // visualization is consistent regardless of which tab is selected):
        drawZone(gst, lpt, 'var(--legend-trading)');                 // Trading
        drawZone(lpt, efc, 'var(--legend-post)');                    // Post-placement
        drawZone(efc, resolvedAt !== null ? resolvedAt : nowMs,      // Awaiting UMA
                 'var(--legend-closed)');

        // Resolution dot (only if resolved_at is in the visible window)
        if (resolvedAt !== null && resolvedAt >= tMin && resolvedAt <= tMax) {
            const cx = xOf(resolvedAt).toFixed(1);
            const fill = m.outcome === 'win' ? 'var(--legend-won)' : 'var(--legend-lost)';
            parts.push(`<circle cx="${cx}" cy="${rowMid}" r="5" fill="${fill}" stroke="#0a0a0f" stroke-width="1.5"/>`);
        }

        // Bet markers (only if placed_at is in the visible window)
        for (const b of m.bets) {
            if (!b.placed_at) continue;
            const betMs = Date.parse(b.placed_at);
            if (betMs < tMin || betMs > tMax) continue;
            const bx = xOf(betMs).toFixed(1);
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
['pw-lc-city', 'pw-lc-type', 'pw-lc-state', 'pw-lc-hide-old'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderLifecycle);
});

// Restore strategy tab from localStorage and wire click handlers
(function initStrategyTabs() {
    // Apply source-based tab visibility BEFORE restoring the selected strategy,
    // so if the saved selection is now hidden (e.g. user was on "Modal early"
    // and reloads on Live tab) the fallback to 'all' inside applySourceTabVisibility
    // runs before setStrategy paints a stale highlight.
    applySourceTabVisibility();
    const saved = currentStrategy();
    setStrategy(saved);  // paint initial UI state
    document.querySelectorAll('.strategy-tab').forEach(btn => {
        btn.addEventListener('click', () => setStrategy(btn.dataset.strategy));
    });
})();

// Restore + wire the post-fix-only toggle. Default ON (boundary_fix 2026-04-25).
(function initPostfixToggle() {
    const cb = document.getElementById('pw-postfix-only');
    if (!cb) return;
    cb.checked = postfixOnly();
    cb.addEventListener('change', () => setPostfixOnly(cb.checked));
})();

// Restore + wire the Paper / Live source toggle.
(function initSourceToggle() {
    const saved = currentSource();
    document.querySelectorAll('.pw-source-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.source === saved);
        btn.addEventListener('click', () => setSource(btn.dataset.source));
    });
    // Set initial tagline text
    const tagline = document.getElementById('pw-source-tagline');
    if (tagline && saved === 'live') {
        tagline.textContent = 'Live trading from Mac. Real CLOB orders on No-side between brackets.';
    }
})();
