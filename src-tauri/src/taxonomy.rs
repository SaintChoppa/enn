//! Taxonomía de géneros (Sprint 3, T1).
//!
//! Las etiquetas en bruto de cada fuente («Latin Trap», «Rock alternativo»,
//! «Reggaeton», «Música»…) se pasan a unas 40 familias, y una tabla dice
//! cuánto se parecen dos familias (0 = nada, 1 = la misma). La tabla vive en
//! `data/taxonomy.json` para poder afinarla sin tocar el código.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Deserialize;

const DATA: &str = include_str!("../data/taxonomy.json");

#[derive(Deserialize)]
struct Raw {
    blacklist: Vec<String>,
    /// nombre para la interfaz de cada familia
    labels: HashMap<String, String>,
    /// familia → palabras clave (se buscan como palabras enteras)
    families: std::collections::BTreeMap<String, Vec<String>>,
    near: Vec<(String, String, f32)>,
}

pub struct Taxonomy {
    blacklist: HashSet<String>,
    labels: HashMap<String, String>,
    families: Vec<(String, Vec<String>)>,
    near: HashMap<(String, String), f32>,
}

static TAX: OnceLock<Taxonomy> = OnceLock::new();

pub fn get() -> &'static Taxonomy {
    TAX.get_or_init(|| {
        let raw: Raw = serde_json::from_str(DATA).expect("data/taxonomy.json válido");
        let mut near = HashMap::new();
        for (a, b, w) in raw.near {
            near.insert((a.clone(), b.clone()), w);
            near.insert((b, a), w);
        }
        Taxonomy {
            blacklist: raw.blacklist.iter().map(|s| norm(s)).collect(),
            labels: raw.labels,
            families: raw
                .families
                .into_iter()
                .map(|(f, kws)| (f, kws.iter().map(|k| norm(k)).collect()))
                .collect(),
            near,
        }
    })
}

/// Minúsculas, sin acentos, solo letras y números separados por un espacio.
pub fn norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = true;
    for c in s.chars().flat_map(char::to_lowercase) {
        let c = match c {
            'á' | 'à' | 'ä' | 'â' | 'ã' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            c => c,
        };
        if c.is_alphanumeric() {
            out.push(c);
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    }
    out.trim_end().to_string()
}

impl Taxonomy {
    /// Familias de una etiqueta en bruto (vacío si no dice nada útil).
    pub fn families_of(&self, raw: &str) -> Vec<String> {
        let n = norm(raw);
        if self.blacklist.contains(&n) {
            return Vec::new();
        }
        let padded = format!(" {n} ");
        self.families
            .iter()
            .filter(|(_, kws)| kws.iter().any(|k| padded.contains(&format!(" {k} "))))
            .map(|(f, _)| f.clone())
            .collect()
    }

    /// Etiqueta que no dice nada («Music», «Other»…).
    pub fn is_blacklisted(&self, raw: &str) -> bool {
        self.blacklist.contains(&norm(raw))
    }

    /// Parecido entre dos familias, de 0 a 1.
    pub fn closeness(&self, a: &str, b: &str) -> f32 {
        if a == b {
            return 1.0;
        }
        self.near
            .get(&(a.to_string(), b.to_string()))
            .copied()
            .unwrap_or(0.0)
    }

    /// Nombre de una familia para la interfaz («regueton» → «Reguetón»).
    pub fn label(&self, f: &str) -> String {
        self.labels
            .get(f)
            .cloned()
            .unwrap_or_else(|| f.replace('-', " "))
    }

    #[cfg(test)]
    pub fn family_ids(&self) -> Vec<String> {
        self.families.iter().map(|(f, _)| f.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fams(raw: &str) -> Vec<String> {
        let mut v = get().families_of(raw);
        v.sort();
        v
    }

    #[test]
    fn normalizes_accents_case_and_symbols() {
        assert_eq!(norm("  Reguetón  "), "regueton");
        assert_eq!(norm("Hip-Hop/Rap"), "hip hop rap");
        assert_eq!(norm("R&B"), "r b");
        assert_eq!(norm("J-Pop"), "j pop");
    }

    #[test]
    fn raw_tags_map_to_families() {
        for (raw, want) in [
            ("Rock", "rock"),
            ("rock", "rock"),
            ("Classic Rock", "rock"),
            ("Alternative", "alternativo"),
            ("Rock alternativo", "alternativo"),
            ("Indie", "indie"),
            ("Heavy Metal", "metal"),
            ("Pop", "pop"),
            ("Reggaeton", "regueton"),
            ("Reguetón", "regueton"),
            ("Trap", "trap"),
            ("Hip-Hop/Rap", "hip-hop"),
            ("Rap", "hip-hop"),
            ("R&B/Soul", "rnb"),
            ("Electro", "electronica"),
            ("Dance", "dance"),
            ("House", "house"),
            ("J-Pop", "j-pop"),
            ("K-Pop", "k-pop"),
            ("Música Mexicana", "regional"),
            ("Salsa", "tropical"),
            ("Lo-Fi", "lo-fi"),
            ("Soundtrack", "banda-sonora"),
            ("Bandas sonoras", "banda-sonora"),
            ("Jazz", "jazz"),
            ("Soul & Funk", "soul-funk"),
        ] {
            assert!(
                fams(raw).contains(&want.to_string()),
                "{raw} → {:?}, esperaba {want}",
                fams(raw)
            );
        }
    }

    #[test]
    fn compound_tags_give_every_family() {
        // «latin trap» es trap y también urbano latino
        let f = fams("Latin Trap");
        assert!(
            f.contains(&"trap".into()) && f.contains(&"urbano-latino".into()),
            "{f:?}"
        );
        let f = fams("Latin Urbano");
        assert!(f.contains(&"urbano-latino".into()), "{f:?}");
    }

    #[test]
    fn every_family_has_a_label() {
        for f in get().family_ids() {
            assert!(get().labels.contains_key(&f), "falta el nombre de {f}");
        }
        assert_eq!(get().label("regueton"), "Reguetón");
    }

    #[test]
    fn useless_tags_are_blacklisted() {
        for raw in [
            "Music", "música", "Musica", "Other", "Otros", "Unknown", "", "  ",
        ] {
            assert!(
                get().is_blacklisted(raw),
                "{raw:?} debería estar en la lista negra"
            );
            assert!(get().families_of(raw).is_empty(), "{raw:?}");
        }
        assert!(!get().is_blacklisted("Rock"));
        // algo que no se reconoce no es lista negra, pero no da familia
        assert!(get().families_of("zzz qqq").is_empty());
    }

    #[test]
    fn closeness_is_symmetric_and_sensible() {
        let t = get();
        assert_eq!(t.closeness("rock", "rock"), 1.0);
        assert_eq!(
            t.closeness("rock", "alternativo"),
            t.closeness("alternativo", "rock")
        );
        assert!(t.closeness("rock", "alternativo") >= 0.6);
        assert!(t.closeness("trap", "regueton") >= 0.5);
        assert!(
            t.closeness("rock", "regueton") < 0.2,
            "rock y reguetón no se parecen"
        );
        assert_eq!(t.closeness("rock", "no-existe"), 0.0);
    }

    #[test]
    fn there_are_about_forty_families_and_every_pair_names_real_ones() {
        let ids = get().family_ids();
        assert!((35..=50).contains(&ids.len()), "{} familias", ids.len());
        // cada familia se alcanza desde otra (nada aislado)
        for a in &ids {
            let best = ids
                .iter()
                .filter(|b| *b != a)
                .map(|b| get().closeness(a, b))
                .fold(0.0f32, f32::max);
            assert!(best > 0.0, "{a} no tiene ninguna familia cercana");
        }
    }
}
