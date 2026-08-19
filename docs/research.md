# WFM forecasting and staffing: research notes

Synthesis of a three-track literature and practice review (August 2026): forecasting methods, staffing math, and queue strategy. Sources listed at the end; inline citations refer to that list.

## 1. How the industry forecasts today

Commercial WFM platforms (Verint, NICE IEX, Alvaria, Calabrio, injixo) share a two-step pattern: forecast volume at monthly/weekly/daily grain from historical seasonality, then allocate to 15/30-minute intervals with intraday distribution curves keyed to day of week [S1][S2]. The workhorse algorithms:

- Weighted or seasonal moving averages: average the same weekday and interval over the last N weeks, with recency weights. Trivial and hard to beat past a few days of horizon [S3][S4].
- Holt-Winters triple exponential smoothing: level, trend, seasonality with recency weighting. The backbone of most WFM systems; overfits unremoved anomalies [S1].
- ARIMA/SARIMA: handles autocorrelation; double-seasonal forms handle two cycles. Neither Holt-Winters nor ARIMA dominates; results flip across datasets [S1][S3].
- Vendor "best pick": NICE advertises 45+ algorithms with per-queue selection over historical backtests. Selection, not combination [S2].

## 2. What the evidence says about method choice

**Taylor 2008** (Management Science) is the benchmark study on intraday call arrivals: seasonal ARIMA and double-seasonal Holt-Winters win up to about 2-3 days ahead; beyond that, a simple historical average is difficult to beat [S3]. Follow-up work confirms the seasonal moving average outperforms complex methods at exactly the horizons where staffing decisions get made [S4].

**Machine learning wins only with covariates.** The strongest published ML result (Albrecht, Rausch, Derra 2021: 174 weeks of half-hourly retail arrivals, rolling-window cross-validation) put random forest ahead of classical time series at interval grain, driven by calendar and event features [S5]. Barrow and Kourentzes 2016 showed a shallow neural net with sinusoidal inputs plus special-day dummies beat ARIMA and exponential smoothing, mainly by modeling outlier days cheaply [S6]. Depth does not pay: a rolling-horizon shallow net beat an echo state network on three real datasets while running 2.5-4.5x faster [S7]. Prophet has no published win on call arrival data.

**Combinations beat selection.** Bastianin, Galeotti, Manera 2018 ran 14 models plus 7 combination schemes on real arrival series and found simple combinations (average, trimmed mean, median) competitive with the best single model, with lower selection risk; they also showed variance (not just mean) accuracy has direct staffing cost [S8]. The best single method flips between queues and periods, which is exactly the failure combinations hedge [S1].

**Multiple-seasonality machinery.** TBATS (trigonometric seasonality, Box-Cox, ARMA errors) was built for exactly this data shape, and MSTL decomposes multiple seasonal cycles; the lighter equivalent is dynamic harmonic regression, Fourier terms per cycle plus regression errors, which Hyndman recommends for long seasonal periods because it also accepts covariates directly [S28]. Gradient boosting with calendar and lag features is the other documented tree-ensemble route; a 2023 Expert Systems with Applications paper pairs it with temporal memory networks on call arrivals, and it shares the covariate-driven advantage of the random forest result [S29].

**Call arrival counts are overdispersed Poisson.** Observed interval variance runs 5x+ the mean, so prediction intervals from naive Poisson assumptions are too tight [S9]. Academic treatments model the arrival rate itself as random (mixed models on square-root-transformed counts) [S10].

**Two-step beats direct interval modeling, if the profiles are learned.** Independent per-interval models are too noisy; naive fixed day-of-week curves are too rigid. Shen and Huang 2008 reduce the intraday profile to a few SVD factors, forecast those, and support principled within-day updating from morning actuals [S11]. Practitioner reforecasting is simpler: apply the actual/forecast ratio from completed intervals to the remaining day, trusting it after 2-3 hours of actuals and acting past a ~5% move [S12].

**Accuracy measurement.** MAPE explodes on small-denominator intervals and daily MAPE hides compensating intraday errors. WAPE (total absolute error / total actual volume) is the recommended primary metric because it weights error by the staffing risk it carries; bias is tracked separately [S13][S14]. Mature targets for a stable voice queue: daily WAPE 5-10%, weekly 3-7%; interval accuracy typically lands 80-90% [S14]. Evaluation standard: rolling-origin backtests at interval, daily, and weekly grain [S5].

## 3. Staffing math

**Erlang C** models the interval as an M/M/c queue. Offered load `A = volume * AHT / interval_seconds` erlangs. Probability of waiting via the numerically stable Erlang B recursion (`B(0)=1; B(k)=A*B(k-1)/(k+A*B(k-1))`; `C = N*B / (N - A*(1-B))`), then:

```
SL(t)     = 1 - C(N,A) * exp(-(N - A) * t / AHT)
ASA       = C(N,A) * AHT / (N - A)
Occupancy = A / N
```

Agent requirement: start at `N = ceil(A) + 1`, increment until SL target met, then gross up by shrinkage. Known failure: infinite patience means predicted abandonment is zero, so Erlang C overstates staff wherever real callers abandon, with the bias growing at high load; material above roughly 3% abandonment or 93% occupancy [S15][S16].

**Erlang A** (M/M/c+M, exponential patience) fixes that: staffing differences of 5-20% vs Erlang C depending on patience and target, plus it predicts abandonment so you can staff to dual targets [S16][S17]. Patience is the mean of the patience distribution, not the mean wait of abandoned calls (censoring); estimate via survival analysis, or first-pass from `P(abandon) = theta * E[wait]`. Compute via the birth-death chain (death rate `N*mu + k*theta` for k waiting) [S17].

**Channel math.** Chat: concurrency-adjusted Erlang (agent as c servers), calibrating AHT at the concurrency actually run [S18]. Email/back office: not a queue problem; workload math `FTE = volume * AHT / (interval * occupancy_target)` spread across the service window with backlog carryover [S19].

**Shrinkage** (industry 30-35%): divide, never multiply (`scheduled = bodies / (1 - shrinkage)`), and use interval-level shrinkage profiles because breaks and meetings cluster (an aggregate 30% can be 45% at 3pm) [S20]. **Occupancy**: cap sustainable voice occupancy at ~85-90%; above that, AHT inflates and attrition follows, so add staff even when SL is met [S21].

## 4. Scenario and what-if modeling in practice

The standing artifact is the weekly capacity plan: a spreadsheet with one column per week, 12-18 months out, a demand block (forecast volume x AHT through Erlang or workload math, grossed up by shrinkage) and a supply block (headcount walk: starting HC + graduating hire classes - attrition +/- transfers, converted to productive FTE through ramp curves), with the over/(under) line driving hire class size and timing [S30][S31]. Standard levers: volume, AHT, shrinkage, absenteeism, attrition, hire class size and timing, ramp speed, occupancy target, SL target. Practice keeps base/upside/downside scenarios, runs single-lever sensitivity ("AHT drops 10%?"), and tracks budget vs plan vs actual weekly [S30].

The levers are worth modeling because Erlang output is non-linear in its inputs: near the SL target one agent moves SL by several points at high occupancy, and under-staffing is punished faster than over-staffing because abandonment rises sharply once wait exceeds typical patience [S17][S21].

"Ad-hoc staffing reallocations" in job practice is the intraday version of the same math: monitor actual vs forecast by interval, reforecast, then move capacity without adding hours: break/lunch shifts, overtime/VTO flex, and cross-trained skill moves between queues. The analyst models before acting: pull 5 agents from email to voice for 90 minutes, voice SL recovers to X, email backlog grows by Y items but stays inside its service window. Even 10-20% cross-trained agents yields large SL gains during spikes [S12][S22][S32].

## 5. Queue strategy: centralized vs decentralized

The square-root staffing law (`N ≈ R + β√R`) means the safety cushion grows with the square root of load, so pooling always cuts the cushion for a single call type: typical gains 5-15% of staff at the same service level [S22][S23]. Small groups buy service level with idle time (86% vs 96% occupancy at the same 80/30 target across a ~6x size difference) [S23].

Pooling is not free with multiple call types: van Dijk and van der Sluis show the gain is the product of a pooling factor (positive) and a mix factor that can turn negative when service-time distributions differ or generalists run slower than specialists [S24]. Splits also win on regulatory/client separation (public sector), language, and specialization economics.

Skill-based routing is the practical middle: two-skill agents capture nearly all the pooling benefit, so limited cross-training with chained skills (A+B, B+C, ...) is the standard design [S25]. Risks: occupancy concentrates on the most cross-trained agents, per-queue forecasts double-count pooled supply, and routing interventions add adherence noise [S22]. Erlang C cannot size a multi-skill operation; simulation is the accepted tool [S26].

Evaluating the choice with data: measure cross-queue arrival correlation (uncorrelated or negatively correlated queues pool best), compare required FTE merged vs split at the same SL via Erlang A, then simulate SBR variants with common random numbers and stress the mix factor with generalist AHT penalties [S22][S24][S26].

## 6. Gap analysis: existing free tools

Open-source Erlang calculators (pyErlang, erlang_c, web calculators) share the same gaps: one interval at a time, Erlang C only (no abandonment), no shrinkage layer, no forecast module, no accuracy scorecard, no multi-skill [S27]. A tool doing interval-level forecasting plus Erlang A staffing plus backtested accuracy reporting exceeds everything freely available.

## 7. Recommended custom model

Design chosen for this project, justified by the evidence above:

**An inverse-WAPE, horizon-aware ensemble over cleaned data with learned intraday profiles.**

1. **Clean first**: MAD-based outlier detection per weekday/interval cell, holiday tagging (events become features or exclusions, not noise), because Holt-Winters and averages overfit anomalies [S1].
2. **Component models** (all fit at daily grain, then intervalized):
   - Seasonal moving average: trimmed, recency-weighted same-weekday average (the long-horizon champion [S3][S4]).
   - Holt-Winters with weekly seasonality on daily totals (the short-horizon champion [S3]).
   - Dynamic harmonic regression: ridge regression on Fourier terms (weekly + yearly), linear trend, holiday and holiday-adjacent dummies (the covariate learner; captures special days the way the ML winners do [S5][S6]).
3. **Combine, don't select**: weights per queue and per horizon bucket proportional to inverse rolling-origin WAPE, so the ensemble tilts toward smoothing at short horizons and toward the seasonal average at long horizons automatically. This is a strict superset of vendor best-pick [S8].
4. **Learned intraday profiles**: recency-weighted day-of-week curves re-estimated from cleaned history (not fixed templates), applied to the daily ensemble forecast; structure mirrors Shen-Huang without the SVD machinery, and keeps the two-step shape planners already trust [S11].
5. **Honest evaluation**: rolling-origin backtest, WAPE + bias at interval/daily/weekly grain, every component reported next to the ensemble so the tool proves (or disproves) its own advantage on the loaded data [S13][S14].

Deliberately excluded for v1: gradient boosting (needs a Python service; the ensemble captures most of the documented gain via the DHR covariates), and neural nets (evidence favors shallow + features, which DHR already approximates).

## Sources

- S1. Call Centre Helper, top call centre forecasting models: https://www.callcentrehelper.com/the-latest-techniques-for-call-centre-forecasting-117394.htm
- S2. WFM Labs, NICE workforce management: https://wiki.wfmlabs.org/wiki/NICE_Workforce_Management
- S3. Taylor (2008), univariate methods for intraday call center arrivals, Management Science: https://users.ox.ac.uk/~mast0315/CallCenterFcstComparison.pdf
- S4. Seasonal moving average for intraday call arrivals, Journal of Business Research: https://www.sciencedirect.com/science/article/abs/pii/S0148296316304490
- S5. Albrecht, Rausch, Derra (2021), Call me maybe, Journal of Business Research: https://ideas.repec.org/a/eee/jbrese/v123y2021icp267-278.html
- S6. Barrow, Kourentzes (2016), special days in call arrivals forecasting: https://www.sciencedirect.com/science/article/abs/pii/S0377221716305525
- S7. Manno et al. (2022), deep vs shallow nets for call center arrivals, Soft Computing: https://link.springer.com/article/10.1007/s00500-022-07055-2
- S8. Bastianin, Galeotti, Manera (2018), statistical and economic evaluation of forecasting models: https://arxiv.org/abs/1804.08315
- S9. Ibrahim, Ye, L'Ecuyer, Shen (2016), call center arrivals literature survey: https://www.sciencedirect.com/science/article/abs/pii/S016920701500151X
- S10. Aldor-Noiman, Feigin, Mandelbaum (2009), workload forecasting: https://arxiv.org/abs/1009.5741
- S11. Shen, Huang (2008), interday forecasting and intraday updating: https://pubsonline.informs.org/doi/10.1287/msom.1070.0179
- S12. WFM Labs, intraday reforecasting: https://wiki.wfmlabs.org/wiki/Intraday_Reforecasting_and_Real-Time_Forecast_Updates
- S13. WFM Labs, MAPE, WAPE and forecast bias: https://wiki.wfmlabs.org/wiki/MAPE_WAPE_and_Forecast_Bias
- S14. ccplanning.net, forecast accuracy metrics: https://ccplanning.net/articles/forecast-accuracy-metrics.html
- S15. WFM Labs, Erlang C: https://wiki.wfmlabs.org/wiki/Erlang_C
- S16. Robbins, Erlang A vs Erlang C comparison (working paper): https://myweb.ecu.edu/robbinst/PDFs/Comparing%20Erlang%20A%20and%20Erlang%20C%20-%20WP.pdf
- S17. WFM Labs, Erlang A: https://wiki.wfmlabs.org/wiki/Erlang-A
- S18. CCmath, Erlang calculators (C, X, chat): https://www.ccmath.com/erlang-calculators/
- S19. Assembled, asynchronous SLA and backlog forecasting: https://support.assembled.com/hc/en-us/articles/6138360516365
- S20. Call Centre Helper, calculating shrinkage: https://www.callcentrehelper.com/how-to-calculate-contact-centre-shrinkage-90353.htm
- S21. Call Centre Helper, service level vs occupancy: https://www.callcentrehelper.com/service-level-vs-occupancy-207027.htm
- S22. WFM Labs, multi-skill scheduling: https://wiki.wfmlabs.org/wiki/Multi-Skill_Scheduling
- S23. Omnitouch, pooling principle: https://www.omnitouchinternational.com/what-you-need-to-know-about-the-pooling-principle-in-contact-centers/
- S24. van Dijk, van der Sluis, To pool or not to pool in call centers: https://pure.uva.nl/ws/files/1319044/96100_334fulltext.pdf
- S25. Peopleware, skills-based workforce planning: https://blog.peopleware.com/scheduling/skills-based-worforce-planning-gain-without-the-pain
- S26. WFM Labs, simulation methods in WFM: https://wiki.wfmlabs.org/wiki/Simulation_Methods_in_Workforce_Management
- S27. CCmath calculators and GitHub Erlang implementations (pyErlang, mhicoayala/erlang_c, phubers/erlang): https://github.com/AntonioGallego/pyErlang
- S28. Hyndman, Athanasopoulos, FPP3, dynamic harmonic regression: https://otexts.com/fpp3/dhr.html ; De Livera, Hyndman, Snyder (2011), TBATS: https://robjhyndman.com/papers/ComplexSeasonality.pdf
- S29. Temporal memory networks and gradient boosting for call arrivals, Expert Systems with Applications (2023): https://www.sciencedirect.com/science/article/abs/pii/S0957417423004852
- S30. Assembled, capacity planning for workforce management: https://www.assembled.com/university/capacity-planning-for-workforce-management
- S31. Northridge Group, contact center new hire capacity planning: https://northridgegroup.com/contact-center-new-hire-capacity-planning/
- S32. WFM Labs, real-time schedule adjustment: https://wiki.wfmlabs.org/wiki/Real-Time_Schedule_Adjustment

Note on evidence strength: wiki.wfmlabs.org is a practitioner wiki; its quantified claims (5-15% pooling gain, shrinkage benchmarks) are consistent with the peer-reviewed sources but not themselves peer-reviewed. The strongest citations are Taylor 2008 [S3], Albrecht 2021 [S5], Bastianin 2018 [S8], Shen-Huang 2008 [S11], and van Dijk-van der Sluis [S24].
