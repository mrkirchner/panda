//! Subtitle files next to a video (`Heat (1995).en.srt`), as Bazarr and most tools write them.
//!
//! A sidecar belongs to a video when its name is the video's name (without extension), then
//! optional dot-separated tags, then a subtitle extension: `<stem>[.<lang>][.forced|.sdh|.hi|
//! .cc|.default].<srt|ass|ssa|vtt>`. Tags may come in any order. Like embedded text tracks,
//! sidecars are converted to `WebVTT` and drawn by the client; nothing is burned in.

use std::path::{Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

use tokio::process::Command;

use crate::ffmpeg::FfmpegPaths;
use crate::{Error, Result};

/// Extensions read as sidecar subtitles (all text formats ffmpeg converts to `WebVTT`).
pub const EXTENSIONS: &[&str] = &["srt", "ass", "ssa", "vtt"];

/// Video files, to tell another video in the folder from this one's other files (keep in step
/// with `panda_library::scan::VIDEO_EXTENSIONS`).
const VIDEO_EXTENSIONS: &[&str] =
    &["mkv", "mp4", "m4v", "mov", "avi", "ts", "m2ts", "webm", "wmv", "mpg", "mpeg"];

/// Larger "subtitle" files are something else; never read them.
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sidecar {
    /// File name only (never a path), in the video's folder.
    pub file_name: String,
    /// `en`, `eng`, `pt-BR`... as written in the name (lowercased language, region kept).
    pub language: Option<String>,
    pub forced: bool,
    /// Subtitles for the deaf and hard of hearing (`.sdh`, `.hi`, `.cc`).
    pub hearing_impaired: bool,
    pub default: bool,
    /// The extension: `srt`, `ass`, `ssa` or `vtt`.
    pub format: String,
}

impl Sidecar {
    /// A short stable id for URLs (no file names or paths in them): FNV-1a of the name.
    pub fn id(&self) -> String {
        id_of(&self.file_name)
    }
}

/// The URL id of a sidecar file name. See [`Sidecar::id`].
pub fn id_of(file_name: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in file_name.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Whether `file_name` is a sidecar of the video whose stem (name without extension) is
/// `video_stem`, and what its name says about it.
pub fn parse(video_stem: &str, file_name: &str) -> Option<Sidecar> {
    let rest = strip_prefix_ci(file_name, video_stem)?;
    let (tags, ext) = rest.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    if !EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    // `rest` is "" (same name) or ".tag.tag" before the extension: anything else is another
    // video's sidecar (`Heat (1995) - 4K.srt` isn't `Heat (1995).mkv`'s).
    if !tags.is_empty() && !tags.starts_with('.') {
        return None;
    }
    let mut out = Sidecar {
        file_name: file_name.to_string(),
        language: None,
        forced: false,
        hearing_impaired: false,
        default: false,
        format: ext,
    };
    for tag in tags.split('.').filter(|t| !t.is_empty()) {
        match tag.to_ascii_lowercase().as_str() {
            "forced" | "foreign" => out.forced = true,
            "sdh" | "cc" => out.hearing_impaired = true,
            // Bazarr's hearing-impaired tag after a language (`.en.hi`); on its own, `hi` is
            // Hindi (`Movie.hi.srt`).
            "hi" if out.language.is_some() => out.hearing_impaired = true,
            "default" => out.default = true,
            t => {
                if out.language.is_none() {
                    out.language = language_tag(t);
                }
            }
        }
    }
    Some(out)
}

/// Case-insensitive prefix strip (exact first; ASCII case folding as a fallback). Names are
/// compared in NFC: a video named on a Mac (NFD) and a subtitle Bazarr wrote on Linux (NFC)
/// still match. The rest comes back NFC.
fn strip_prefix_ci(s: &str, prefix: &str) -> Option<String> {
    let s: String = s.nfc().collect();
    let prefix: String = prefix.nfc().collect();
    if let Some(r) = s.strip_prefix(prefix.as_str()) {
        return Some(r.to_string());
    }
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(&prefix).then(|| s[prefix.len()..].to_string())
}

/// ISO 639-1 codes, then the ISO 639-2 (B and T) codes of the languages subtitles come in.
const LANGUAGE_CODES: &str = "aa ab af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy \
da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io \
is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb \
nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su \
sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu \
alb sqi ara arm hye baq eus bel ben bos bul bur mya cat chi zho hrv cze ces dan dut nld eng est fil fin fre fra geo kat \
ger deu gre ell heb hin hun ice isl ind gle ita jpn kan kaz khm kor lav lit mac mkd may msa mal mar mon nep nor nob nno \
per fas pol por pan rum ron rus srp sin slo slk slv spa swa swe tgl tam tel tha tib bod tur ukr urd uzb vie wel cym yid \
zul afr amh aze glg guj hau ibo kin kur lao ltz mlt mao mri orm pus que sna som sot sun tat tir tuk uig wol xho yor";

/// A language from one name tag: a two/three-letter code, a code with a region or script
/// (`pt-BR`, `zh-Hans`, `pt_BR`), or a common English language name.
fn language_tag(tag: &str) -> Option<String> {
    let (base, region) = match tag.split_once(['-', '_']) {
        Some((b, r)) => (b, Some(r)),
        None => (tag, None),
    };
    // Only real ISO 639 codes: other short tags (`web`, `dvd`, `mkv`) aren't languages.
    let is_code = (2..=3).contains(&base.len())
        && base.bytes().all(|b| b.is_ascii_alphabetic())
        && LANGUAGE_CODES.split(' ').any(|c| c.eq_ignore_ascii_case(base));
    if is_code {
        let base = base.to_ascii_lowercase();
        return Some(match region {
            Some(r) if (2..=4).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric()) => {
                // BCP 47 casing: regions upper (BR), scripts title (Hans).
                let r = if r.len() == 4 {
                    let mut c = r.to_ascii_lowercase();
                    c[..1].make_ascii_uppercase();
                    c
                } else {
                    r.to_ascii_uppercase()
                };
                format!("{base}-{r}")
            }
            Some(_) => return None,
            None => base,
        });
    }
    if region.is_some() {
        return None;
    }
    let code = match tag.to_ascii_lowercase().as_str() {
        "english" => "en",
        "spanish" | "espanol" | "español" => "es",
        "french" | "francais" | "français" => "fr",
        "german" | "deutsch" => "de",
        "italian" => "it",
        "portuguese" => "pt",
        "dutch" => "nl",
        "swedish" => "sv",
        "norwegian" => "no",
        "danish" => "da",
        "finnish" => "fi",
        "polish" => "pl",
        "russian" => "ru",
        "japanese" => "ja",
        "korean" => "ko",
        "chinese" => "zh",
        "arabic" => "ar",
        "hebrew" => "he",
        "turkish" => "tr",
        "greek" => "el",
        _ => return None,
    };
    Some(code.to_string())
}

/// The sidecars of `video` in its folder, sorted by language then name; an error when the folder
/// can't be read (a dropped share). Blocking (a directory listing): call it off the async
/// runtime, under a timeout (libraries live on network shares).
pub fn find(video: &Path) -> std::io::Result<Vec<(Sidecar, PathBuf)>> {
    let (Some(dir), Some(stem)) = (video.parent(), video.file_stem().and_then(|s| s.to_str())) else {
        return Ok(Vec::new());
    };
    let entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(std::result::Result::ok).collect();
    // Other videos here whose names extend this one's (`Movie.Extended.mkv` beside `Movie.mkv`):
    // their sidecars (`Movie.Extended.en.srt`) match this stem too, but aren't this video's.
    let longer: Vec<String> = entries
        .iter()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|n| n.rsplit_once('.').map(|(s, ext)| (s.to_string(), ext.to_ascii_lowercase())))
        .filter(|(s, ext)| {
            s.len() > stem.len() && VIDEO_EXTENSIONS.contains(&ext.as_str()) && parse_stem_ext(stem, s)
        })
        .map(|(s, _)| s)
        .collect();
    let mut out: Vec<(Sidecar, PathBuf)> = entries
        .iter()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let s = parse(stem, &name)?;
            if longer.iter().any(|other| parse(other, &name).is_some()) {
                return None;
            }
            let meta = e.metadata().ok()?;
            (meta.is_file() && meta.len() <= MAX_BYTES).then(|| (s, e.path()))
        })
        .collect();
    out.sort_by(|(a, _), (b, _)| (&a.language, &a.file_name).cmp(&(&b.language, &b.file_name)));
    Ok(out)
}

/// Whether `other` is `stem` plus dot-separated parts (another video named after this one).
fn parse_stem_ext(stem: &str, other: &str) -> bool {
    strip_prefix_ci(other, stem).is_some_and(|rest| rest.starts_with('.'))
}

/// The character set to tell ffmpeg for a subtitle file's bytes: `None` for UTF-8 (with or
/// without a BOM; ffmpeg's default) and for UTF-16 with a BOM (ffmpeg's demuxers convert it
/// themselves: naming it would decode it twice), else Windows-1252, what most older `.srt`
/// files are.
pub fn charset(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        return None;
    }
    std::str::from_utf8(bytes).is_err().then_some("CP1252")
}

pub fn webvtt_args(input: &Path, charset: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-v", "error"].map(String::from).to_vec();
    if let Some(c) = charset {
        a.extend(["-sub_charenc".into(), c.into()]);
    }
    a.extend(
        ["-i", &input.to_string_lossy(), "-map", "0:s:0", "-c:s", "webvtt", "-f", "webvtt", "-"]
            .map(String::from),
    );
    a
}

/// Convert a sidecar subtitle file to a `WebVTT` document (ASS styling is flattened to text,
/// as for embedded tracks).
pub async fn extract_webvtt(paths: &FfmpegPaths, input: &Path, charset: Option<&str>) -> Result<String> {
    let out = Command::new(&paths.ffmpeg)
        .args(webvtt_args(input, charset))
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|source| Error::Spawn { bin: paths.ffmpeg.display().to_string(), source })?;
    if !out.status.success() {
        return Err(Error::Failed {
            bin: "ffmpeg".into(),
            status: out.status,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str) -> Option<Sidecar> {
        parse("Heat (1995)", name)
    }

    #[test]
    fn plain_and_language() {
        let s = p("Heat (1995).srt").unwrap();
        assert_eq!((s.language, s.forced, s.hearing_impaired), (None, false, false));
        assert_eq!(p("Heat (1995).en.srt").unwrap().language.as_deref(), Some("en"));
        assert_eq!(p("Heat (1995).eng.srt").unwrap().language.as_deref(), Some("eng"));
        assert_eq!(p("Heat (1995).English.srt").unwrap().language.as_deref(), Some("en"));
        assert_eq!(p("Heat (1995).pt-br.srt").unwrap().language.as_deref(), Some("pt-BR"));
        assert_eq!(p("Heat (1995).pt_BR.srt").unwrap().language.as_deref(), Some("pt-BR"));
        assert_eq!(p("Heat (1995).zh-hans.ass").unwrap().language.as_deref(), Some("zh-Hans"));
    }

    #[test]
    fn bazarr_flags() {
        let s = p("Heat (1995).en.hi.srt").unwrap();
        assert!(s.hearing_impaired && !s.forced);
        let s = p("Heat (1995).es.forced.srt").unwrap();
        assert!(s.forced);
        assert_eq!(s.language.as_deref(), Some("es"));
        let s = p("Heat (1995).sdh.en.srt").unwrap();
        assert!(s.hearing_impaired);
        assert_eq!(s.language.as_deref(), Some("en"));
        assert!(p("Heat (1995).en.cc.srt").unwrap().hearing_impaired);
        assert!(p("Heat (1995).en.default.srt").unwrap().default);
    }

    #[test]
    fn release_tags_are_not_languages() {
        assert_eq!(p("Heat (1995).web.en.srt").unwrap().language.as_deref(), Some("en"));
        assert_eq!(p("Heat (1995).mkv.srt").unwrap().language, None);
        assert_eq!(p("Heat (1995).dvd.es.srt").unwrap().language.as_deref(), Some("es"));
        assert_eq!(p("Heat (1995).ger.srt").unwrap().language.as_deref(), Some("ger"));
    }

    #[test]
    fn mac_and_linux_unicode_forms_match() {
        // Video named on a Mac (NFD: `e` + a combining accent), subtitle written on Linux (NFC).
        let s = parse("Ame\u{301}lie (2001)", "Am\u{e9}lie (2001).fr.srt").unwrap();
        assert_eq!(s.language.as_deref(), Some("fr"));
        assert_eq!(s.file_name, "Am\u{e9}lie (2001).fr.srt", "the name on disk is kept");
        assert!(parse("Am\u{e9}lie (2001)", "Ame\u{301}lie (2001).srt").is_some());
    }

    #[test]
    fn an_unreadable_folder_is_an_error() {
        assert!(find(Path::new("/nonexistent-panda-dir/Movie.mkv")).is_err());
    }

    #[test]
    fn hi_alone_is_hindi() {
        let s = p("Heat (1995).hi.srt").unwrap();
        assert_eq!(s.language.as_deref(), Some("hi"));
        assert!(!s.hearing_impaired);
        let s = p("Heat (1995).en.hi.srt").unwrap();
        assert_eq!(s.language.as_deref(), Some("en"));
        assert!(s.hearing_impaired);
    }

    #[test]
    fn another_videos_sidecars_are_left_out() {
        let dir = tempfile::tempdir().unwrap();
        // `Movie.en.sup` / `.idx` are this video's other subtitles, not another video.
        for f in [
            "Movie.mkv",
            "Movie.Extended.mkv",
            "Movie.Extended.en.srt",
            "Movie.en.srt",
            "Movie.en.sup",
            "Movie.en.idx",
        ] {
            std::fs::write(dir.path().join(f), b"1").unwrap();
        }
        let names = |v: &str| -> Vec<String> {
            find(&dir.path().join(v)).unwrap().into_iter().map(|(s, _)| s.file_name).collect()
        };
        assert_eq!(names("Movie.mkv"), ["Movie.en.srt"]);
        assert_eq!(names("Movie.Extended.mkv"), ["Movie.Extended.en.srt"]);
    }

    #[test]
    fn other_files_are_not_sidecars() {
        assert!(p("Heat (1995).mkv").is_none());
        assert!(p("Heat (1995).nfo").is_none());
        assert!(p("Heat (1995) - 4K.en.srt").is_none());
        assert!(p("Heat (1995)-trailer.srt").is_none());
        assert!(p("Other.en.srt").is_none());
        assert!(p("Heat").is_none());
    }

    #[test]
    fn case_and_extension_case() {
        assert!(p("heat (1995).EN.SRT").is_some());
        assert_eq!(p("Heat (1995).en.VTT").unwrap().format, "vtt");
    }

    #[test]
    fn episode_names() {
        let s = parse("Show - S01E02 - Title", "Show - S01E02 - Title.fr.ass").unwrap();
        assert_eq!(s.language.as_deref(), Some("fr"));
        assert_eq!(s.format, "ass");
    }

    #[test]
    fn unknown_tags_are_ignored() {
        let s = p("Heat (1995).en.1.srt").unwrap();
        assert_eq!(s.language.as_deref(), Some("en"));
        assert_eq!(p("Heat (1995).something.srt").unwrap().language, None);
    }

    #[test]
    fn ids_are_stable_and_short() {
        assert_eq!(id_of("a.srt"), id_of("a.srt"));
        assert_ne!(id_of("a.en.srt"), id_of("a.es.srt"));
        assert_eq!(id_of("a.srt").len(), 16);
    }

    #[test]
    fn charsets() {
        assert_eq!(charset("héllo".as_bytes()), None);
        assert_eq!(charset(b"\xef\xbb\xbfhi"), None);
        assert_eq!(charset(b"caf\xe9"), Some("CP1252"));
        assert_eq!(charset(b"\xff\xfeh\0"), None, "UTF-16 with a BOM: ffmpeg converts it");
        assert_eq!(charset(b"\xfe\xff\0h"), None);
    }

    #[test]
    fn args_pass_charset_before_input() {
        let a = webvtt_args(Path::new("/m/a.srt"), Some("CP1252")).join(" ");
        assert!(a.contains("-sub_charenc CP1252 -i /m/a.srt -map 0:s:0 -c:s webvtt -f webvtt -"));
        assert!(!webvtt_args(Path::new("/m/a.srt"), None).join(" ").contains("sub_charenc"));
    }

    #[test]
    fn finds_in_folder_sorted() {
        let dir = tempfile::tempdir().unwrap();
        for f in ["Heat (1995).mkv", "Heat (1995).es.srt", "Heat (1995).en.srt", "Heat (1995).nfo", "x.srt"] {
            std::fs::write(dir.path().join(f), b"1").unwrap();
        }
        let found = find(&dir.path().join("Heat (1995).mkv")).unwrap();
        let names: Vec<_> = found.iter().map(|(s, _)| s.file_name.as_str()).collect();
        assert_eq!(names, ["Heat (1995).en.srt", "Heat (1995).es.srt"]);
    }
}
