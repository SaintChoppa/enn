//! Radio que sigue el hilo (Sprint 3, T5).
//!
//! La propuesta del propietario (Rock, alternativo → Alternativo, trap →
//! Trap…) es una caminata por etiquetas compartidas; se combina con lo que
//! hace la radio de YouTube Music: vecinas, variedad de artistas, tu
//! costumbre y tu gusto. Cada elección lleva su motivo.

use std::collections::{HashMap, VecDeque};

/// Lo que la radio sabe de cada canción de la biblioteca.
#[derive(Clone, Debug, Default)]
pub struct SongView {
    pub key: String,
    /// artistas normalizados
    pub artists: Vec<String>,
    pub title: String,
    pub tags: Vec<(String, f32)>,
    pub bpm: Option<f32>,
    pub energy: Option<f32>,
    /// sonoridad integrada (LUFS), del análisis de volumen
    pub loudness: Option<f32>,
    pub plays: u32,
    pub completions: u32,
    pub skips: u32,
    pub favorite: bool,
    pub last_played: Option<u64>,
    pub last_skip: Option<u64>,
}

/// Relación de cada candidata con la canción actual.
#[derive(Clone, Debug, Default)]
pub struct Rel {
    /// puesto en la radio de YouTube Music de la actual (0 = la primera)
    pub neighbor_rank: HashMap<usize, usize>,
    /// veces que pasaste de la actual a esa
    pub trans: HashMap<usize, u32>,
}

/// Afinador (menú del botón de radio).
#[derive(Clone, Copy, Debug)]
pub struct Tuner {
    /// 0 baja, 1 media, 2 alta
    pub variety: u8,
    /// −1 familiar … +1 descubrir
    pub selection: f32,
    /// −1 estricta … +1 aventurera
    pub coherence: f32,
}

impl Default for Tuner {
    fn default() -> Self {
        Tuner {
            variety: 1,
            selection: 0.0,
            coherence: 0.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pick {
    pub index: usize,
    pub score: f32,
    pub reason: String,
}

/// Estado de la sesión de radio: ambiente, saltos y lo que ya sonó.
#[derive(Clone, Debug, Default)]
pub struct Session {
    pub mood: HashMap<String, f32>,
    avoid: HashMap<String, f32>,
    pub recent: VecDeque<String>,
    skips_in_row: u32,
    last_full: Option<Vec<(String, f32)>>,
    step: u64,
    rng: u64,
}

/// Saltos seguidos tras los que la radio vuelve al ambiente de la última
/// canción escuchada entera.
const SKIPS_TO_RESET: u32 = 3;
/// Cuántas recuerda la sesión.
const RECENT_CAP: usize = 200;
/// Ventana sin repetir (se acorta a la mitad de la biblioteca si es pequeña).
const NO_REPEAT: usize = 80;
/// 1 de cada 8 elecciones es un descubrimiento.
const DISCOVERY_EVERY: u64 = 8;

impl Session {
    pub fn new(seed: u64) -> Self {
        Session {
            rng: seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1,
            ..Default::default()
        }
    }

    fn remember(&mut self, s: &SongView) {
        self.recent.push_back(s.key.clone());
        while self.recent.len() > RECENT_CAP {
            self.recent.pop_front();
        }
    }

    /// Sonó entera: refuerza la dirección (media móvil ≈ las 5 últimas).
    pub fn on_end(&mut self, s: &SongView) {
        self.remember(s);
        for v in self.mood.values_mut() {
            *v *= 0.67;
        }
        for (f, w) in &s.tags {
            *self.mood.entry(f.clone()).or_default() += 0.33 * w;
        }
        self.mood.retain(|_, v| *v > 0.02);
        for v in self.avoid.values_mut() {
            *v *= 0.85;
        }
        self.avoid.retain(|_, v| *v > 0.02);
        if !s.tags.is_empty() {
            self.last_full = Some(s.tags.clone());
        }
        self.skips_in_row = 0;
        self.step += 1;
    }

    /// Saltada pronto: aleja el ambiente de sus etiquetas.
    pub fn on_skip(&mut self, s: &SongView) {
        self.remember(s);
        for (f, w) in &s.tags {
            *self.avoid.entry(f.clone()).or_default() += 0.5 * w;
            if let Some(m) = self.mood.get_mut(f) {
                *m *= 0.7;
            }
        }
        self.skips_in_row += 1;
        if self.skips_in_row >= SKIPS_TO_RESET {
            if let Some(t) = self.last_full.clone() {
                self.mood = t.into_iter().collect();
            }
            self.avoid.clear();
            self.skips_in_row = 0;
        }
        self.step += 1;
    }

    /// Elegida a mano: recentra la sesión en ella (como iniciar una radio).
    pub fn on_manual(&mut self, s: &SongView) {
        self.remember(s);
        if !s.tags.is_empty() {
            self.mood = s.tags.iter().cloned().collect();
        }
        for v in self.avoid.values_mut() {
            *v *= 0.5;
        }
        self.skips_in_row = 0;
    }

    /// Número entre 0 y 1 (SplitMix64: determinista con la misma semilla).
    fn rand(&mut self) -> f32 {
        self.rng = self.rng.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.rng;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 40) as f32 / (1u64 << 24) as f32
    }
}

/// Parecido de dos listas de etiquetas (0–1), con la cercanía entre familias.
fn sim(a: &[(String, f32)], b: &[(String, f32)]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let tax = crate::taxonomy::get();
    let num: f32 = a
        .iter()
        .flat_map(|(f, wa)| b.iter().map(move |(g, wb)| wa * wb * tax.closeness(f, g)))
        .sum();
    let den: f32 = a.iter().map(|x| x.1).sum::<f32>() * b.iter().map(|x| x.1).sum::<f32>();
    if den > 0.0 {
        (num / den).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn max_closeness(a: &[(String, f32)], b: &[(String, f32)]) -> f32 {
    let tax = crate::taxonomy::get();
    a.iter()
        .flat_map(|(f, _)| b.iter().map(move |(g, _)| tax.closeness(f, g)))
        .fold(0.0, f32::max)
}

fn shares_family(a: &[(String, f32)], b: &[(String, f32)]) -> bool {
    a.iter().any(|(f, _)| b.iter().any(|(g, _)| f == g))
}

fn top_family(t: &[(String, f32)]) -> Option<&str> {
    t.iter()
        .max_by(|x, y| x.1.total_cmp(&y.1))
        .map(|x| x.0.as_str())
}

/// Peldaños de la escalera de relajación: nunca se queda sin candidata.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Level {
    /// comparte familia, otro artista, fuera de la ventana
    Strict,
    /// familia cercana
    Near,
    /// familia cercana, mismo artista permitido
    NearSameArtist,
    /// familia cercana con una ventana más corta
    NearShortWindow,
    /// solo continuidad sonora
    Sound,
    /// cualquiera que no sea la actual
    Any,
}

const LEVELS: [Level; 6] = [
    Level::Strict,
    Level::Near,
    Level::NearSameArtist,
    Level::NearShortWindow,
    Level::Sound,
    Level::Any,
];

/// Las `n` siguientes para después de `cur`.
pub fn pick_next(
    songs: &[SongView],
    cur: Option<usize>,
    rel: &Rel,
    st: &mut Session,
    tuner: &Tuner,
    now: u64,
    n: usize,
) -> Vec<Pick> {
    let mut picks: Vec<Pick> = Vec::new();
    for _ in 0..n {
        match pick_one(songs, cur, rel, st, tuner, now, &picks) {
            Some(p) => picks.push(p),
            None => break,
        }
    }
    picks
}

fn pick_one(
    songs: &[SongView],
    cur: Option<usize>,
    rel: &Rel,
    st: &mut Session,
    tuner: &Tuner,
    now: u64,
    taken: &[Pick],
) -> Option<Pick> {
    let tax = crate::taxonomy::get();
    let c = cur.map(|i| &songs[i]);
    let window = NO_REPEAT.min(songs.len() / 2).max(1);
    let in_window = |key: &str, w: usize| st.recent.iter().rev().take(w).any(|k| k == key);
    let last3: Vec<&String> = st.recent.iter().rev().take(3).collect();
    let by_key: HashMap<&str, usize> = songs
        .iter()
        .enumerate()
        .map(|(i, s)| (s.key.as_str(), i))
        .collect();
    let recent_artists: Vec<&String> = last3
        .iter()
        .filter_map(|k| by_key.get(k.as_str()))
        .flat_map(|i| songs[*i].artists.iter())
        .collect();
    let same_artist =
        |s: &SongView| c.is_some_and(|c| c.artists.iter().any(|a| s.artists.contains(a)));
    let near = |s: &SongView| match c {
        Some(c) if !c.tags.is_empty() && !s.tags.is_empty() => {
            max_closeness(&c.tags, &s.tags) >= 0.2
        }
        _ => true,
    };
    let open = |i: usize| Some(i) != cur && !taken.iter().any(|p| p.index == i);
    let mood: Vec<(String, f32)> = st.mood.iter().map(|(k, v)| (k.clone(), *v)).collect();
    let discovery = st.step % DISCOVERY_EVERY == DISCOVERY_EVERY - 1;

    for level in LEVELS {
        let ok = |i: usize, s: &SongView| -> bool {
            if !open(i) {
                return false;
            }
            let recent_2h = s.last_played.is_some_and(|t| now.saturating_sub(t) < 7_200);
            match level {
                Level::Strict => {
                    let thread = match c {
                        Some(c) if !c.tags.is_empty() && !s.tags.is_empty() => {
                            shares_family(&c.tags, &s.tags)
                        }
                        _ => true,
                    };
                    thread && !same_artist(s) && !in_window(&s.key, window) && !recent_2h
                }
                Level::Near => {
                    near(s) && !same_artist(s) && !in_window(&s.key, window) && !recent_2h
                }
                Level::NearSameArtist => near(s) && !in_window(&s.key, window),
                Level::NearShortWindow => near(s) && !in_window(&s.key, (window / 4).max(1)),
                Level::Sound => !in_window(&s.key, window),
                Level::Any => true,
            }
        };
        let cands: Vec<usize> = songs
            .iter()
            .enumerate()
            .filter(|(i, s)| ok(*i, s))
            .map(|(i, _)| i)
            .collect();
        if cands.is_empty() {
            continue;
        }
        // descubrimiento: entre las poco escuchadas pero cercanas
        let pool: Vec<usize> = if discovery && level == Level::Strict {
            let mut plays: Vec<u32> = cands.iter().map(|i| songs[*i].plays).collect();
            plays.sort_unstable();
            let median = plays[plays.len() / 2];
            let low: Vec<usize> = cands
                .iter()
                .copied()
                .filter(|i| songs[*i].plays <= median)
                .collect();
            if low.is_empty() {
                cands
            } else {
                low
            }
        } else {
            cands
        };
        let variety_pen = [0.15f32, 0.3, 0.6][tuner.variety.min(2) as usize];
        let mut scored: Vec<(usize, f32, &'static str)> = pool
            .iter()
            .map(|&i| {
                let s = &songs[i];
                let thread = c.map(|c| sim(&c.tags, &s.tags)).unwrap_or(0.0);
                let m = sim(&mood, &s.tags);
                let neighbor = rel
                    .neighbor_rank
                    .get(&i)
                    .map(|r| 1.0 - (*r as f32 / 50.0).min(1.0))
                    .unwrap_or(0.0);
                let habit = rel
                    .trans
                    .get(&i)
                    .map(|t| (*t as f32 / 3.0).min(1.0))
                    .unwrap_or(0.0);
                // gusto: escuchas completas, favorita y escuchada hace poco (un mes)
                let recency = s
                    .last_played
                    .map(|t| 1.0 - (now.saturating_sub(t) as f32 / (30.0 * 86_400.0)).min(1.0))
                    .unwrap_or(0.0);
                let taste = (s.completions as f32 + 1.0) / (s.plays as f32 + 2.0)
                    + if s.favorite { 0.3 } else { 0.0 }
                    + 0.4 * recency;
                let novelty = (tuner.selection + 1.0) * 0.3 / (1.0 + s.plays as f32);
                let sound = match (c.and_then(|c| c.bpm), s.bpm) {
                    (Some(a), Some(b)) => 1.0 - ((a - b).abs() / 40.0).min(1.0),
                    _ => 0.5,
                } * 0.4
                    + match (c.and_then(|c| c.energy), s.energy) {
                        (Some(a), Some(b)) => 1.0 - (a - b).abs().min(1.0),
                        _ => 0.5,
                    } * 0.3
                    // y volumen parecido (sonoridad del análisis de volumen)
                    + match (c.and_then(|c| c.loudness), s.loudness) {
                        (Some(a), Some(b)) => 1.0 - ((a - b).abs() / 10.0).min(1.0),
                        _ => 0.5,
                    } * 0.3;
                let mut pen = 0.0;
                if s.artists.iter().any(|a| recent_artists.contains(&a)) {
                    pen += variety_pen;
                }
                if s.last_skip.is_some_and(|t| now.saturating_sub(t) < 86_400) {
                    pen += 0.4;
                }
                pen += 0.3 * s.skips as f32 / (s.plays as f32 + 1.0);
                pen += s
                    .tags
                    .iter()
                    .map(|(f, w)| st.avoid.get(f).copied().unwrap_or(0.0) * w)
                    .sum::<f32>();
                let kc = 1.0 - 0.5 * tuner.coherence;
                let parts = [
                    (3.0 * kc * thread, "hilo"),
                    (1.5 * m, "ambiente"),
                    (1.5 * neighbor, "vecina"),
                    (1.2 * habit, "costumbre"),
                    (0.8 * (1.0 - 0.5 * tuner.selection) * taste, "gusto"),
                    (0.6 * sound, "sonido"),
                    (novelty, "novedad"),
                ];
                let total: f32 = parts.iter().map(|p| p.0).sum::<f32>() - pen;
                let why = parts
                    .iter()
                    .max_by(|a, b| a.0.total_cmp(&b.0))
                    .map(|p| p.1)
                    .unwrap_or("azar");
                (i, total, why)
            })
            .collect();
        // un poco de azar para deshacer empates, y muestreo entre las mejores
        for x in scored.iter_mut() {
            x.1 += st.rand() * 0.12;
        }
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored.truncate(4);
        let floor = scored.last().map(|x| x.1).unwrap_or(0.0);
        let weights: Vec<f32> = scored
            .iter()
            .map(|x| (x.1 - floor + 0.05).powi(3))
            .collect();
        let sum: f32 = weights.iter().sum();
        let mut r = st.rand() * sum;
        let mut chosen = scored[0];
        for (x, w) in scored.iter().zip(&weights) {
            if r <= *w {
                chosen = *x;
                break;
            }
            r -= w;
        }
        let s = &songs[chosen.0];
        let reason = explain(
            c,
            s,
            chosen.2,
            level,
            discovery && level == Level::Strict,
            tax,
        );
        return Some(Pick {
            index: chosen.0,
            score: chosen.1,
            reason,
        });
    }
    None
}

/// Motivo visible de una elección.
fn explain(
    c: Option<&SongView>,
    s: &SongView,
    why: &str,
    level: Level,
    discovery: bool,
    tax: &crate::taxonomy::Taxonomy,
) -> String {
    let label = |f: Option<&str>| f.map(|f| tax.label(f));
    let to = label(top_family(&s.tags));
    if discovery {
        return match to {
            Some(t) => format!("Descubrimiento: poco escuchada y cercana ({t})"),
            None => "Descubrimiento: poco escuchada".into(),
        };
    }
    let title = c.map(|c| c.title.as_str()).unwrap_or("");
    match (why, level) {
        ("vecina", _) => format!("Vecina de «{title}» en la radio de YouTube Music"),
        ("costumbre", _) => format!("Sueles ponerla después de «{title}»"),
        (_, Level::Sound) | (_, Level::Any) => match s.bpm {
            Some(b) if level == Level::Sound => {
                format!("Cambio de aires, a un ritmo parecido (~{b:.0} BPM)")
            }
            _ => "Al azar de tu biblioteca".into(),
        },
        _ => {
            let from = c.and_then(|c| {
                // la familia de la actual que más se parece a la elegida
                c.tags
                    .iter()
                    .max_by(|a, b| {
                        let ka = s
                            .tags
                            .iter()
                            .map(|(g, _)| tax.closeness(&a.0, g))
                            .fold(0.0, f32::max);
                        let kb = s
                            .tags
                            .iter()
                            .map(|(g, _)| tax.closeness(&b.0, g))
                            .fold(0.0, f32::max);
                        ka.total_cmp(&kb)
                    })
                    .map(|x| tax.label(&x.0))
            });
            match (from, to) {
                (Some(f), Some(t)) if f == t => format!("Sigue el hilo: {f}"),
                (Some(f), Some(t)) => format!("Sigue el hilo: {f} → {t}"),
                (None, Some(t)) => format!("Sigue el ambiente: {t}"),
                _ => "Al azar de tu biblioteca".into(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::taxonomy;

    fn song(i: usize, artist: &str, tags: &[(&str, f32)]) -> SongView {
        SongView {
            key: format!("k{i}"),
            artists: vec![artist.to_lowercase()],
            title: format!("Canción {i}"),
            tags: tags.iter().map(|(f, w)| (f.to_string(), *w)).collect(),
            bpm: Some(100.0 + (i % 40) as f32),
            energy: Some(0.5),
            ..Default::default()
        }
    }

    /// Cinco familias encadenadas por canciones puente (rock — alternativo —
    /// trap — reguetón — tropical), 20 canciones por familia y 3 puentes en
    /// cada unión; 4 artistas por familia.
    fn chain_library() -> Vec<SongView> {
        let fams = ["rock", "alternativo", "trap", "regueton", "tropical"];
        let mut v = Vec::new();
        for (fi, f) in fams.iter().enumerate() {
            for j in 0..20 {
                let i = v.len();
                v.push(song(i, &format!("{f}-artista-{}", j % 4), &[(f, 1.0)]));
            }
            if fi + 1 < fams.len() {
                for j in 0..3 {
                    let i = v.len();
                    v.push(song(
                        i,
                        &format!("puente-{fi}-{j}"),
                        &[(f, 1.0), (fams[fi + 1], 0.8)],
                    ));
                }
            }
        }
        v
    }

    fn fams_of(s: &SongView) -> Vec<&str> {
        s.tags.iter().map(|(f, _)| f.as_str()).collect()
    }

    fn shares(a: &SongView, b: &SongView) -> bool {
        fams_of(a).iter().any(|f| fams_of(b).contains(f))
    }

    fn walk(lib: &[SongView], start: usize, steps: usize, seed: u64) -> Vec<usize> {
        let mut st = Session::new(seed);
        let mut cur = start;
        st.on_manual(&lib[cur]);
        let mut seq = vec![cur];
        for t in 0..steps {
            let p = pick_next(
                lib,
                Some(cur),
                &Rel::default(),
                &mut st,
                &Tuner::default(),
                10_000 + t as u64 * 200,
                1,
            );
            assert!(!p.is_empty(), "la radio no puede quedarse sin canción");
            cur = p[0].index;
            st.on_end(&lib[cur]);
            seq.push(cur);
        }
        seq
    }

    #[test]
    fn consecutive_picks_share_a_family_while_there_is_one() {
        let lib = chain_library();
        let seq = walk(&lib, 0, 15, 42);
        for w in seq.windows(2) {
            assert!(
                shares(&lib[w[0]], &lib[w[1]]),
                "{:?} → {:?}",
                fams_of(&lib[w[0]]),
                fams_of(&lib[w[1]])
            );
        }
    }

    #[test]
    fn never_the_same_artist_twice_in_a_row() {
        let lib = chain_library();
        let seq = walk(&lib, 0, 200, 7);
        for w in seq.windows(2) {
            assert!(
                lib[w[0]]
                    .artists
                    .iter()
                    .all(|a| !lib[w[1]].artists.contains(a)),
                "mismo artista seguido: {} → {}",
                lib[w[0]].key,
                lib[w[1]].key
            );
        }
    }

    #[test]
    fn does_not_repeat_inside_the_window() {
        let lib = chain_library();
        let seq = walk(&lib, 0, 40, 3);
        let mut seen = std::collections::HashSet::new();
        for i in &seq {
            assert!(seen.insert(*i), "se repitió {} en 40 pasos", lib[*i].key);
        }
    }

    #[test]
    fn never_empty_with_two_or_more_songs() {
        // dos canciones del mismo artista y sin etiquetas
        let lib = vec![song(0, "a", &[]), song(1, "a", &[])];
        let mut st = Session::new(1);
        for _ in 0..10 {
            let p = pick_next(
                &lib,
                Some(0),
                &Rel::default(),
                &mut st,
                &Tuner::default(),
                1,
                1,
            );
            assert_eq!(p.len(), 1);
            assert_eq!(p[0].index, 1);
        }
        // sin canción actual también
        assert_eq!(
            pick_next(
                &lib,
                None,
                &Rel::default(),
                &mut st,
                &Tuner::default(),
                1,
                1
            )
            .len(),
            1
        );
        // una sola canción: no hay otra que poner
        assert!(pick_next(
            &lib[..1],
            Some(0),
            &Rel::default(),
            &mut st,
            &Tuner::default(),
            1,
            1
        )
        .is_empty());
    }

    #[test]
    fn an_early_skip_makes_that_family_less_likely() {
        // la actual es puente rock/alternativo: las dos familias valen
        let lib = chain_library();
        let bridge = 20; // primer puente
        let count_rock = |skip: bool| {
            let mut rock = 0;
            for seed in 0..200 {
                let mut st = Session::new(seed);
                st.on_manual(&lib[bridge]);
                if skip {
                    st.on_skip(&lib[0]); // salto pronto de una de rock
                }
                let p = pick_next(
                    &lib,
                    Some(bridge),
                    &Rel::default(),
                    &mut st,
                    &Tuner::default(),
                    1,
                    1,
                );
                if fams_of(&lib[p[0].index]) == ["rock"] {
                    rock += 1;
                }
            }
            rock
        };
        let (before, after) = (count_rock(false), count_rock(true));
        assert!(after < before, "rock antes {before}, tras el salto {after}");
    }

    #[test]
    fn a_manual_pick_recenters_the_session() {
        let lib = chain_library();
        let mut st = Session::new(9);
        // llevaba un rato en rock
        for s in &lib[..5] {
            st.on_manual(s);
            st.on_end(s);
        }
        // el usuario pone una de trap a mano
        let trap = 50;
        assert_eq!(fams_of(&lib[trap]), ["trap"]);
        st.on_manual(&lib[trap]);
        let p = pick_next(
            &lib,
            Some(trap),
            &Rel::default(),
            &mut st,
            &Tuner::default(),
            1,
            1,
        );
        assert!(
            fams_of(&lib[p[0].index]).contains(&"trap"),
            "{:?}",
            fams_of(&lib[p[0].index])
        );
    }

    #[test]
    fn every_pick_explains_itself() {
        let lib = chain_library();
        let mut st = Session::new(5);
        st.on_manual(&lib[0]);
        let p = pick_next(
            &lib,
            Some(0),
            &Rel::default(),
            &mut st,
            &Tuner::default(),
            1,
            3,
        );
        assert_eq!(p.len(), 3);
        for x in &p {
            assert!(!x.reason.is_empty());
        }
        assert!(p[0].reason.contains("Rock"), "{}", p[0].reason);
        // distintas entre sí
        assert!(p[0].index != p[1].index && p[1].index != p[2].index && p[0].index != p[2].index);
    }

    #[test]
    fn youtube_neighbors_and_your_habits_pull_a_song_up() {
        let lib = chain_library();
        let target = 15; // otra de rock
        let mut rel = Rel::default();
        rel.trans.insert(target, 6);
        rel.neighbor_rank.insert(target, 0);
        let mut hits = 0;
        for seed in 0..50 {
            let mut st = Session::new(seed);
            st.on_manual(&lib[0]);
            let p = pick_next(&lib, Some(0), &rel, &mut st, &Tuner::default(), 1, 1);
            if p[0].index == target {
                hits += 1;
            }
        }
        assert!(hits > 25, "la favorita de tu costumbre salió {hits} de 50");
    }

    /// Dos candidatas iguales salvo `diff`: cuántas veces de 100 gana la primera.
    fn wins_of_first(cur: SongView, a: SongView, b: SongView, now: u64) -> usize {
        let lib = vec![cur, a, b];
        (0..100)
            .filter(|seed| {
                let mut st = Session::new(*seed);
                st.on_manual(&lib[0]);
                pick_next(
                    &lib,
                    Some(0),
                    &Rel::default(),
                    &mut st,
                    &Tuner::default(),
                    now,
                    1,
                )[0]
                .index
                    == 1
            })
            .count()
    }

    #[test]
    fn a_similar_loudness_keeps_the_flow() {
        let mut cur = song(0, "x", &[("rock", 1.0)]);
        cur.loudness = Some(-8.0);
        let mut near = song(1, "y", &[("rock", 1.0)]);
        near.loudness = Some(-8.5);
        let mut far = song(2, "z", &[("rock", 1.0)]);
        far.loudness = Some(-20.0);
        (near.bpm, far.bpm) = (cur.bpm, cur.bpm);
        let w = wins_of_first(cur, near, far, 1);
        assert!(w > 70, "la de volumen parecido ganó {w} de 100");
    }

    #[test]
    fn songs_you_played_lately_count_as_your_taste() {
        let now = 400 * 86_400;
        let cur = song(0, "x", &[("rock", 1.0)]);
        let mut recent = song(1, "y", &[("rock", 1.0)]);
        recent.last_played = Some(now - 86_400);
        let mut old = song(2, "z", &[("rock", 1.0)]);
        old.last_played = Some(now - 300 * 86_400);
        (recent.bpm, old.bpm) = (cur.bpm, cur.bpm);
        let w = wins_of_first(cur, recent, old, now);
        assert!(w > 70, "la escuchada hace poco ganó {w} de 100");
    }

    /// Simulación de la prueba de aceptación: 1 000 pasos por la biblioteca
    /// encadenada. Cambios bruscos (sin familia en común ni cercana) < 2 % y
    /// todas las familias alcanzables.
    #[test]
    fn a_thousand_steps_drift_smoothly_and_reach_every_family() {
        let lib = chain_library();
        let tax = taxonomy::get();
        let seq = walk(&lib, 0, 1_000, 2026);
        let near = |a: &SongView, b: &SongView| {
            a.tags
                .iter()
                .any(|(f, _)| b.tags.iter().any(|(g, _)| tax.closeness(f, g) > 0.0))
        };
        let abrupt = seq
            .windows(2)
            .filter(|w| !near(&lib[w[0]], &lib[w[1]]))
            .count();
        let strict = seq
            .windows(2)
            .filter(|w| shares(&lib[w[0]], &lib[w[1]]))
            .count();
        eprintln!("simulación: {abrupt} bruscos, {strict} comparten familia, de 1000");
        assert!(abrupt * 100 < 2 * 1_000, "{abrupt} cambios bruscos de 1000");
        let mut reached = std::collections::HashSet::new();
        for i in &seq {
            for f in fams_of(&lib[*i]) {
                reached.insert(f.to_string());
            }
        }
        assert_eq!(reached.len(), 5, "familias alcanzadas: {reached:?}");
    }
}
