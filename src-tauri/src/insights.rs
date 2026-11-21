//! Almacén de escuchas (Sprint 3, T2).
//!
//! Por canción: escuchas, escuchas completas, saltos, fechas, etiquetas
//! (familias de la taxonomía con su peso), rasgos sonoros y vecinas. Y las
//! transiciones «naturales» `anterior → siguiente`: solo cuentan si la
//! siguiente se escuchó al menos a la mitad después de que la anterior
//! terminara o de elegirla a mano. Vive en `insights.json` (guardado atómico
//! y copia anterior en `insights.json.bak`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Se abandona antes de esto (o del 30 % de la canción) = salto.
pub const SKIP_SECS: f64 = 30.0;
pub const SKIP_FRAC: f64 = 0.30;
/// Cada cuánto se limpian las canciones que ya no están.
pub const WEEK: u64 = 7 * 86_400;
/// La siguiente cuenta como transición si se escuchó al menos esta fracción.
pub const TRANSITION_FRAC: f64 = 0.50;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SongStats {
    /// familias de la taxonomía con su peso (0–1)
    pub tags: Vec<(String, f32)>,
    pub bpm: Option<f32>,
    /// 0–1
    pub energy: Option<f32>,
    /// 0–1
    pub brightness: Option<f32>,
    pub plays: u32,
    pub completions: u32,
    pub skips: u32,
    pub first_played: Option<u64>,
    pub last_played: Option<u64>,
    pub last_skip: Option<u64>,
    /// fuentes que aportaron etiquetas («archivo», «deezer», «itunes»…)
    pub sources: Vec<String>,
    /// última consulta en línea (segundos Unix)
    pub fetched_at: Option<u64>,
    /// claves de canciones de la biblioteca vecinas en la radio de YouTube Music, en orden
    pub neighbors: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Insights {
    pub version: u32,
    pub songs: HashMap<String, SongStats>,
    /// anterior → { siguiente: veces }
    pub trans: HashMap<String, HashMap<String, u32>>,
    /// el historial viejo ya se pasó aquí
    pub migrated: bool,
    /// última limpieza de canciones que ya no están (segundos Unix)
    pub pruned_at: u64,
    /// ya se releyó el año real de todas las pistas (una sola vez)
    pub years_synced: bool,
    #[serde(skip)]
    cur: Option<Playing>,
    #[serde(skip)]
    last: Option<Left>,
}

#[derive(Clone, Debug)]
struct Playing {
    key: String,
    dur: f64,
    /// segundos escuchados antes de la última búsqueda
    listened: f64,
    /// dónde empezó el tramo que suena ahora (0, o adonde se buscó)
    seg: f64,
    /// de dónde viene, si la llegada fue «natural»
    from: Option<String>,
}

#[derive(Clone, Debug)]
struct Left {
    key: String,
    ended: bool,
}

/// Clave de una canción: su id de YouTube si lo tiene; si no, la ruta sin
/// extensión y en minúsculas (la misma canción en FLAC y en M4A es una).
pub fn song_key(path: &str, yt_id: Option<&str>) -> String {
    if let Some(id) = yt_id.filter(|s| !s.is_empty()) {
        return format!("yt:{id}");
    }
    let p = path.replace('\\', "/").to_lowercase();
    let stem = match (p.rfind('.'), p.rfind('/')) {
        (Some(dot), Some(slash)) if dot > slash => &p[..dot],
        (Some(dot), None) => &p[..dot],
        _ => &p[..],
    };
    format!("f:{stem}")
}

/// ¿Dejarla en `pos` de `dur` es un salto?
pub fn is_skip(pos: f64, dur: f64) -> bool {
    pos < SKIP_SECS || (dur > 0.0 && pos < dur * SKIP_FRAC)
}

impl Insights {
    fn song(&mut self, key: &str) -> &mut SongStats {
        self.songs.entry(key.to_string()).or_default()
    }

    fn count(&mut self, from: &str, to: &str, delta: i64) {
        let row = self.trans.entry(from.to_string()).or_default();
        let v = row.entry(to.to_string()).or_insert(0);
        *v = (*v as i64 + delta).max(0) as u32;
        if *v == 0 {
            row.remove(to);
        }
    }

    /// Empieza a sonar `key`. `manual`: la eligió el usuario (no la cola ni la radio).
    pub fn on_start(&mut self, key: &str, dur: f64, manual: bool, now: u64) {
        let from = match &self.last {
            Some(l) if (l.ended || manual) && l.key != key => Some(l.key.clone()),
            _ => None,
        };
        let s = self.song(key);
        s.plays += 1;
        s.first_played.get_or_insert(now);
        s.last_played = Some(now);
        self.cur = Some(Playing {
            key: key.to_string(),
            dur,
            listened: 0.0,
            seg: 0.0,
            from,
        });
    }

    /// Llegó al final. Cuenta como escucha completa (y como transición) solo
    /// si de verdad se escuchó al menos la mitad: saltar al final no vale.
    pub fn on_end(&mut self, key: &str, now: u64) {
        let cur = self.cur.take().filter(|c| c.key == key);
        // sin un inicio que cuadre no se sabe qué se escuchó: no cuenta
        let heard = cur.as_ref().is_some_and(|c| {
            let total = c.listened + (c.dur - c.seg).max(0.0);
            c.dur <= 0.0 || total >= c.dur * TRANSITION_FRAC
        });
        let s = self.song(key);
        s.last_played = Some(now);
        if heard {
            s.completions += 1;
            if let Some(f) = cur.and_then(|c| c.from) {
                self.count(&f, key, 1);
            }
        }
        self.last = Some(Left {
            key: key.to_string(),
            ended: true,
        });
    }

    /// El usuario la dejó en `pos` (siguiente, otra canción, parar).
    pub fn on_leave(&mut self, key: &str, pos: f64, now: u64) {
        let cur = self.cur.take().filter(|c| c.key == key);
        let dur = cur.as_ref().map(|c| c.dur).unwrap_or(0.0);
        // lo escuchado de verdad (con las búsquedas), no la posición
        let pos = cur
            .as_ref()
            .map(|c| c.listened + (pos - c.seg).max(0.0))
            .unwrap_or(pos);
        let from = cur.and_then(|c| c.from);
        if is_skip(pos, dur) {
            let s = self.song(key);
            s.skips += 1;
            s.last_skip = Some(now);
            // saltarla justo después de la anterior debilita esa transición
            if let Some(f) = &from {
                self.count(f, key, -1);
            }
        } else if dur > 0.0 && pos >= dur * TRANSITION_FRAC {
            if let Some(f) = &from {
                self.count(f, key, 1);
            }
        }
        self.last = Some(Left {
            key: key.to_string(),
            ended: false,
        });
    }

    /// La canción `old` (guardada por ruta) resultó tener otra clave (su id
    /// de YouTube): todo lo suyo pasa a `new`, sumándose a lo que hubiera.
    pub fn rekey(&mut self, old: &str, new: &str) {
        if old == new {
            return;
        }
        if let Some(o) = self.songs.remove(old) {
            let n = self.songs.entry(new.to_string()).or_default();
            n.plays += o.plays;
            n.completions += o.completions;
            n.skips += o.skips;
            n.first_played = match (n.first_played, o.first_played) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            n.last_played = n.last_played.max(o.last_played);
            n.last_skip = n.last_skip.max(o.last_skip);
            if n.tags.is_empty() {
                n.tags = o.tags;
                n.sources = o.sources;
            }
            n.bpm = n.bpm.or(o.bpm);
            n.energy = n.energy.or(o.energy);
            n.brightness = n.brightness.or(o.brightness);
            n.fetched_at = n.fetched_at.or(o.fetched_at);
            if n.neighbors.is_empty() {
                n.neighbors = o.neighbors;
            }
        }
        // transiciones que salen de la vieja
        if let Some(row) = self.trans.remove(old) {
            for (to, c) in row {
                self.count(new, &to, c as i64);
            }
        }
        // y las que llegan a ella
        let froms: Vec<String> = self
            .trans
            .iter()
            .filter(|(_, r)| r.contains_key(old))
            .map(|(f, _)| f.clone())
            .collect();
        for f in froms {
            if let Some(c) = self.trans.get_mut(&f).and_then(|r| r.remove(old)) {
                self.count(&f, new, c as i64);
            }
        }
        for s in self.songs.values_mut() {
            for k in s.neighbors.iter_mut() {
                if k == old {
                    *k = new.to_string();
                }
            }
        }
        if let Some(c) = self.cur.as_mut() {
            if c.key == old {
                c.key = new.to_string();
            }
            if c.from.as_deref() == Some(old) {
                c.from = Some(new.to_string());
            }
        }
        if let Some(l) = self.last.as_mut() {
            if l.key == old {
                l.key = new.to_string();
            }
        }
    }

    /// Limpieza semanal: quita lo de canciones que ya no están en la
    /// biblioteca (`keep` = claves actuales). Si la biblioteca parece no
    /// estar (vacía, o se iría más de la mitad), no toca nada. Devuelve
    /// cuántas quitó.
    pub fn prune_missing(&mut self, keep: &HashSet<String>, now: u64) -> usize {
        if now.saturating_sub(self.pruned_at) < WEEK || keep.is_empty() {
            return 0;
        }
        let gone: Vec<String> = self
            .songs
            .keys()
            .filter(|k| !keep.contains(*k))
            .cloned()
            .collect();
        if gone.len() * 2 > self.songs.len() {
            return 0; // más de la mitad: la biblioteca no está, no es que se borrara
        }
        self.pruned_at = now;
        let gone_set: HashSet<&String> = gone.iter().collect();
        for k in &gone {
            self.songs.remove(k);
            self.trans.remove(k);
        }
        for row in self.trans.values_mut() {
            row.retain(|to, _| !gone_set.contains(to));
        }
        self.trans.retain(|_, row| !row.is_empty());
        for st in self.songs.values_mut() {
            st.neighbors.retain(|k| !gone_set.contains(k));
        }
        gone.len()
    }

    /// El usuario buscó de `from` a `to` dentro de la canción que suena.
    pub fn on_seek(&mut self, key: &str, from: f64, to: f64) {
        if let Some(c) = self.cur.as_mut().filter(|c| c.key == key) {
            c.listened += (from - c.seg).max(0.0);
            c.seg = to.max(0.0);
        }
    }

    /// Veces que se pasó de `a` a `b`.
    pub fn transitions(&self, a: &str, b: &str) -> u32 {
        self.trans
            .get(a)
            .and_then(|r| r.get(b))
            .copied()
            .unwrap_or(0)
    }

    /// Historial viejo de la interfaz (`enn.history`, ya con claves): una
    /// escucha por entrada. Solo una vez por almacén.
    pub fn migrate_history(&mut self, entries: &[(String, u64)]) {
        if self.migrated {
            return;
        }
        self.migrated = true;
        for (key, ts) in entries {
            let s = self.song(key);
            s.plays += 1;
            s.first_played = Some(s.first_played.map_or(*ts, |f| f.min(*ts)));
            s.last_played = Some(s.last_played.map_or(*ts, |l| l.max(*ts)));
        }
    }

    pub fn load(path: &Path) -> Insights {
        let read = |p: &Path| -> Option<Insights> {
            serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
        };
        if let Some(s) = read(path) {
            return s;
        }
        if path.exists() {
            let moved = crate::fsutil::quarantine(path);
            crate::player::log_warn(&format!(
                "insights.json dañado; apartado en {moved:?}, se usa la copia anterior"
            ));
        }
        read(&backup_of(path)).unwrap_or_default()
    }

    /// Guarda de forma atómica; la versión anterior queda en `.bak`.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if path.is_file() {
            let _ = std::fs::copy(path, backup_of(path));
        }
        let json = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        crate::fsutil::write_atomic(path, &json)
    }
}

fn backup_of(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.bak", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_prefer_the_youtube_id_and_ignore_the_format() {
        assert_eq!(
            song_key("C:/m/A.m4a", Some("4D7u5KF7SP8")),
            "yt:4D7u5KF7SP8"
        );
        assert_eq!(
            song_key("C:\\Music\\Song.FLAC", None),
            song_key("c:/music/song.m4a", None)
        );
        assert_ne!(song_key("C:/m/a.m4a", None), song_key("C:/m/b.m4a", None));
    }

    #[test]
    fn a_skip_is_leaving_before_30_percent_or_30_seconds() {
        assert!(is_skip(20.0, 300.0)); // antes de 30 s
        assert!(is_skip(80.0, 300.0)); // antes del 30 % (90 s)
        assert!(!is_skip(100.0, 300.0));
        assert!(is_skip(25.0, 60.0)); // canción corta: antes de 30 s
        assert!(!is_skip(35.0, 60.0));
    }

    #[test]
    fn counts_plays_completions_and_skips() {
        let mut s = Insights::default();
        s.on_start("a", 200.0, true, 100);
        s.on_end("a", 300);
        s.on_start("b", 200.0, false, 300);
        s.on_leave("b", 10.0, 310);
        let a = &s.songs["a"];
        assert_eq!((a.plays, a.completions, a.skips), (1, 1, 0));
        assert_eq!(a.first_played, Some(100));
        let b = &s.songs["b"];
        assert_eq!((b.plays, b.completions, b.skips), (1, 0, 1));
        assert_eq!(b.last_skip, Some(310));
    }

    #[test]
    fn only_natural_transitions_count() {
        let mut s = Insights::default();
        // a termina y b se escucha entera → cuenta
        s.on_start("a", 100.0, true, 0);
        s.on_end("a", 100);
        s.on_start("b", 100.0, false, 100);
        s.on_end("b", 200);
        assert_eq!(s.transitions("a", "b"), 1);
        // b termina pero c se salta enseguida → no cuenta
        s.on_start("c", 100.0, false, 200);
        s.on_leave("c", 5.0, 205);
        assert_eq!(s.transitions("b", "c"), 0);
        // c se saltó: d llega con ⏭, no es natural aunque se escuche entera
        s.on_start("d", 100.0, false, 205);
        s.on_end("d", 305);
        assert_eq!(s.transitions("c", "d"), 0);
        // elegida a mano y escuchada más de la mitad → cuenta
        s.on_start("e", 100.0, true, 305);
        s.on_leave("e", 60.0, 365);
        assert_eq!(s.transitions("d", "e"), 1);
    }

    #[test]
    fn skipping_right_after_weakens_the_transition() {
        let mut s = Insights::default();
        for t in 0..3 {
            s.on_start("a", 100.0, true, t * 1000);
            s.on_end("a", t * 1000 + 100);
            s.on_start("b", 100.0, false, t * 1000 + 100);
            s.on_end("b", t * 1000 + 200);
        }
        assert_eq!(s.transitions("a", "b"), 3);
        s.on_start("a", 100.0, true, 9000);
        s.on_end("a", 9100);
        s.on_start("b", 100.0, false, 9100);
        s.on_leave("b", 3.0, 9103);
        assert_eq!(s.transitions("a", "b"), 2);
    }

    /// Una canción guardada por ruta que luego resulta tener id de YouTube
    /// se pasa a su clave nueva sin perder nada (escuchas, transiciones y
    /// vecindades), y se suma a lo que ya tuviera la clave nueva.
    #[test]
    fn rekeying_merges_everything_into_the_new_key() {
        let mut s = Insights::default();
        s.on_start("f:a", 100.0, true, 10);
        s.on_end("f:a", 110);
        s.on_start("b", 100.0, false, 110);
        s.on_end("b", 210); // f:a → b
        s.on_start("f:a", 100.0, true, 300);
        s.on_end("f:a", 400); // b → f:a (elegida a mano)
        s.songs.entry("yt:A".into()).or_default().plays = 2;
        s.songs.entry("c".into()).or_default().neighbors = vec!["f:a".into()];
        s.rekey("f:a", "yt:A");
        assert!(!s.songs.contains_key("f:a"));
        let a = &s.songs["yt:A"];
        assert_eq!(a.plays, 4);
        assert_eq!(a.completions, 2);
        assert_eq!(a.first_played, Some(10));
        assert_eq!(s.transitions("yt:A", "b"), 1);
        assert_eq!(s.transitions("b", "yt:A"), 1);
        assert!(!s.trans.contains_key("f:a"));
        assert_eq!(s.songs["c"].neighbors, ["yt:A"]);
        // lo que esté sonando también cambia de clave
        s.on_start("f:z", 100.0, true, 500);
        s.rekey("f:z", "yt:Z");
        s.on_end("yt:Z", 600);
        assert_eq!(s.songs["yt:Z"].completions, 1);
    }

    #[test]
    fn the_weekly_cleanup_drops_songs_that_are_gone() {
        let mut s = Insights::default();
        for k in ["a", "b", "c", "x", "y"] {
            s.songs.entry(k.into()).or_default().plays = 1;
        }
        s.count("a", "x", 2);
        s.count("x", "b", 1);
        s.count("a", "b", 1);
        s.songs.get_mut("c").unwrap().neighbors = vec!["x".into(), "a".into()];
        let keep: HashSet<String> = ["a", "b", "c"].iter().map(|k| k.to_string()).collect();
        assert_eq!(s.prune_missing(&keep, 10 * WEEK), 2);
        let mut left: Vec<&String> = s.songs.keys().collect();
        left.sort();
        assert_eq!(left, ["a", "b", "c"]);
        assert_eq!(s.transitions("a", "x"), 0);
        assert!(!s.trans.contains_key("x"));
        assert_eq!(s.transitions("a", "b"), 1);
        assert_eq!(s.songs["c"].neighbors, ["a"]);
        // una vez por semana
        s.songs.entry("z".into()).or_default();
        assert_eq!(s.prune_missing(&keep, 10 * WEEK + 3600), 0);
        assert_eq!(s.prune_missing(&keep, 11 * WEEK), 1);
    }

    #[test]
    fn the_cleanup_never_wipes_when_the_library_looks_missing() {
        let mut s = Insights::default();
        for k in ["a", "b", "c", "d"] {
            s.songs.entry(k.into()).or_default().plays = 1;
        }
        // biblioteca vacía (carpeta en un disco desconectado): no se toca nada
        assert_eq!(s.prune_missing(&HashSet::new(), 10 * WEEK), 0);
        // se iría más de la mitad: tampoco
        let keep: HashSet<String> = ["a"].iter().map(|k| k.to_string()).collect();
        assert_eq!(s.prune_missing(&keep, 10 * WEEK), 0);
        assert_eq!(s.songs.len(), 4);
    }

    /// Lo que cuenta es lo escuchado, no dónde se dejó (búsquedas).
    #[test]
    fn seeking_counts_listened_time_not_position() {
        let mut s = Insights::default();
        // saltar casi al final y terminar no es escucharla entera
        s.on_start("p", 100.0, true, 0);
        s.on_end("p", 100);
        s.on_start("a", 100.0, false, 100);
        s.on_seek("a", 5.0, 95.0);
        s.on_end("a", 110);
        assert_eq!(s.songs["a"].completions, 0);
        assert_eq!(s.transitions("p", "a"), 0);
        // volver atrás y escuchar más: cuenta todo lo escuchado
        s.on_start("b", 300.0, true, 200);
        s.on_seek("b", 100.0, 0.0);
        s.on_leave("b", 50.0, 400);
        assert_eq!(s.songs["b"].skips, 0, "150 s escuchados no es un salto");
        assert_eq!(
            s.transitions("a", "b"),
            1,
            "elegida a mano y escuchada la mitad"
        );
        // saltar hacia delante y dejarla: salto, aunque se dejara al final
        s.on_start("c", 200.0, true, 500);
        s.on_seek("c", 10.0, 190.0);
        s.on_leave("c", 195.0, 520);
        assert_eq!(s.songs["c"].skips, 1);
        // una búsqueda de otra canción no hace nada
        s.on_seek("zz", 1.0, 2.0);
    }

    #[test]
    fn an_end_without_its_start_is_not_a_full_listen() {
        let mut s = Insights::default();
        s.on_end("x", 10);
        assert_eq!(s.songs["x"].completions, 0);
        // empezar otra vez la misma sin acabarla: la primera se cierra como salto
        s.on_start("y", 100.0, true, 0);
        s.on_leave("y", 10.0, 10);
        s.on_start("y", 100.0, false, 10);
        s.on_end("y", 110);
        assert_eq!(
            (
                s.songs["y"].plays,
                s.songs["y"].completions,
                s.songs["y"].skips
            ),
            (2, 1, 1)
        );
    }

    #[test]
    fn migrates_the_old_history() {
        let mut s = Insights::default();
        s.migrate_history(&[("x".into(), 50), ("y".into(), 40)]);
        assert_eq!(s.songs["x"].plays, 1);
        assert_eq!(s.songs["x"].last_played, Some(50));
        // migrar dos veces no duplica
        s.migrate_history(&[("x".into(), 50)]);
        assert_eq!(s.songs["x"].plays, 1);
    }

    #[test]
    fn saves_atomically_and_restores_the_previous_copy_if_damaged() {
        let dir = std::env::temp_dir().join(format!("enn-ins-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("insights.json");
        let mut s = Insights::default();
        s.on_start("a", 100.0, true, 1);
        s.on_end("a", 101);
        s.save(&p).unwrap();
        s.on_start("b", 100.0, true, 102);
        s.save(&p).unwrap(); // la primera versión pasa a .bak
        assert_eq!(Insights::load(&p).songs.len(), 2);
        std::fs::write(&p, b"{ roto").unwrap();
        let back = Insights::load(&p);
        assert_eq!(back.songs.len(), 1, "se restaura la copia anterior");
        assert_eq!(back.songs["a"].completions, 1);
        // sin nada legible: vacío, sin fallar
        std::fs::write(dir.join("insights.json.bak"), b"xx").unwrap();
        std::fs::write(&p, b"yy").unwrap();
        assert!(Insights::load(&p).songs.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
