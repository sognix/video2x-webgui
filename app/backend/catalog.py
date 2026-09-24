# Copyright (C) 2026 sognix
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Static metadata describing Video2X CLI processors, models and encoder options.

The valid combinations below (which model supports which scaling factor / noise
level, which RIFE model weights actually ship in the AppImage, and that hwaccel
decode is unusable) were determined empirically by running every combination
against the real CLI/GPU — the AppImage only bundles a subset of the weights
the CLI's --help text advertises, and mixing hwaccel decode with the
ncnn/Vulkan filter pipeline reliably breaks. Values here are the ones that
actually work; the GUI should never offer a choice this catalog doesn't list.
"""

# libplacebo: no constraints, every field is independent
LIBPLACEBO = {
    "label": "libplacebo (GLSL shaders / Anime4K)",
    "description": (
        "Fast GLSL shaders (Anime4K). Anime/cartoon content only — not designed for "
        "live-action/real footage. Good default when you want speed over the best "
        "possible detail reconstruction."
    ),
    "kind": "simple",
    "fields": {
        "width": {"type": "int", "required": True, "default": 1920, "label": "Output width"},
        "height": {"type": "int", "required": True, "default": 1080, "label": "Output height"},
        "shader": {
            "type": "enum",
            "default": "anime4k-v4-a",
            "label": "Shader",
            "options": [
                "anime4k-v4-a",
                "anime4k-v4-a+a",
                "anime4k-v4-b",
                "anime4k-v4-b+b",
                "anime4k-v4-c",
                "anime4k-v4-c+a",
                "anime4k-v4.1-gan",
            ],
            "option_notes": {
                "anime4k-v4-a": "Modern anime (2010+) that's already decent quality but a bit soft — sharpens edges and reconstructs detail without changing the art style.",
                "anime4k-v4-a+a": "Mode A applied twice — a stronger version of A for content that needs more correction.",
                "anime4k-v4-b": "Older anime (90s/00s) or anything that looks blurry/out of focus — aggressively reverses blur; can thin out lines but makes the image pop a lot more.",
                "anime4k-v4-b+b": "Mode B applied twice — a stronger version of B.",
                "anime4k-v4-c": "Low-resolution anime, especially ~480p sources.",
                "anime4k-v4-c+a": "Mode C followed by A — low-res anime that also needs extra detail reconstruction.",
                "anime4k-v4.1-gan": "GAN-based — sharper, more detailed results than the non-GAN modes, but slower.",
            },
        },
    },
}

# realesrgan: scaling factor availability depends on the model
REALESRGAN = {
    "label": "RealESRGAN (upscaling)",
    "description": (
        "Neural-network upscaling. Includes both an anime-optimized video model and a "
        "general-purpose model for real photos/live-action footage — pick the model below "
        "based on what the source actually is."
    ),
    "kind": "model-scale",
    "default_model": "realesr-animevideov3",
    "models": {
        "realesr-animevideov3": {
            "scales": [2, 3, 4],
            "description": (
                "Anime & cartoon video (series, movies). Compact and fast, built specifically "
                "for video so it stays stable frame-to-frame. Best default for anime video."
            ),
        },
        "realesrgan-plus-anime": {
            "scales": [4],
            "description": (
                "Anime & cartoon illustrations/stills. Sharper fine detail than animevideov3, "
                "but heavy (~4x the compute) and less temporally stable — mainly worth it for "
                "single images, impractical for full video runs."
            ),
        },
        "realesrgan-plus": {
            "scales": [4],
            "description": (
                "General purpose — real photos and live-action footage (not anime). This is "
                "the original ESRGAN network, the heaviest of the three models here."
            ),
        },
    },
}

# realcugan: which scaling factors exist per model, and which noise levels
# exist per (model, scale) — both vary because only some weight files ship.
REALCUGAN = {
    "label": "RealCUGAN (upscaling)",
    "description": (
        "Neural-network upscaling built specifically for anime-style art/illustration — like "
        "RealESRGAN's anime models but tends to keep textures and out-of-focus areas more "
        "conservatively rather than sharpening everything. Anime/cartoon only, not for "
        "live-action. Noise level is denoise strength: 0 for already-clean sources, higher "
        "for noisy/compressed/old sources (VHS rips, old DVD rips, etc.)."
    ),
    "kind": "model-scale-noise",
    "default_model": "models-se",
    "models": {
        "models-nose": {
            "scales": {"2": [0]},
            "description": "2x only, no denoise control. Produces thin, sharp line edges but loses some fine detail. The oldest/simplest variant.",
        },
        "models-pro": {
            "scales": {"2": [0, 3], "3": [0, 3]},
            "description": "2x/3x. The newest, most accurate variant — recommended over the others when it covers the scale you need.",
        },
        "models-se": {
            "scales": {"2": [0, 1, 2, 3], "3": [0, 3], "4": [0, 3]},
            "description": "2x/3x/4x. Older than \"pro\" but covers the widest range of scale/noise combinations, including 4x.",
        },
    },
    "extra_fields": {
        "threads": {"type": "int", "default": 1, "label": "Threads"},
        "syncgap": {
            "type": "enum",
            "default": "3",
            "label": "Sync gap mode",
            "options": ["0", "1", "2", "3"],
        },
    },
}

# rife: only these 4 model weights are actually bundled in the AppImage,
# even though the CLI's --help text lists 14
RIFE = {
    "label": "RIFE (frame interpolation)",
    "description": (
        "Frame interpolation — raises the frame rate / smooths motion by generating new "
        "in-between frames. This does NOT change resolution, and it works on any content "
        "(anime or live-action) since it's about motion, not image style."
    ),
    "kind": "simple",
    "fields": {
        "frame_rate_mul": {
            "type": "int",
            "required": True,
            "default": 2,
            "label": "Frame rate multiplier",
        },
        "model": {
            "type": "enum",
            "default": "rife-v4.6",
            "label": "Model",
            "options": ["rife-v4.6", "rife-v4.25", "rife-v4.25-lite", "rife-v4.26"],
            "option_notes": {
                "rife-v4.6": "Stable, widely-used baseline version.",
                "rife-v4.25": "Newer than v4.6, generally improved interpolation quality.",
                "rife-v4.25-lite": "Same generation as v4.25 but lighter/faster, slightly less accurate.",
                "rife-v4.26": "Latest bundled version, further refinements over v4.25.",
            },
        },
        "uhd": {"type": "bool", "default": False, "label": "Ultra HD mode"},
    },
}

PROCESSORS = {
    "libplacebo": LIBPLACEBO,
    "realesrgan": REALESRGAN,
    "realcugan": REALCUGAN,
    "rife": RIFE,
}

# hwaccel decode is unfinished in video2x itself (confirmed by the maintainer: it
# only initializes the hardware context, doesn't do the required GPU<->CPU frame
# transfer, "currently not very stable, especially on Linux" — see
# https://github.com/k4yt3x/video2x/issues/1202). It also isn't the bottleneck:
# the upscaling filter already always runs on the GPU via Vulkan regardless of
# this setting. Kept selectable for people who want to experiment, with a warning.
HWACCEL_OPTIONS = ["none", "cuda", "vaapi", "qsv", "vulkan"]
HWACCEL_WARNING = (
    "Anything other than \"none\" is unstable in video2x itself (upstream-confirmed, "
    "not something this image can fix) and commonly fails outright. It also only "
    "affects decoding — the actual upscaling always runs on the GPU via Vulkan "
    "regardless of this setting, so it's rarely a real bottleneck anyway."
)

LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "critical", "none"]
ENCODER_PRESETS = [
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
]

# File extensions batch mode treats as videos. Anything else in a batch folder
# (subtitles, .nfo, images, ...) is skipped instead of queued as a doomed job.
VIDEO_EXTENSIONS = [
    "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg",
    "mts", "ogv", "ts", "vob", "webm", "wmv",
]


def validate_processor_options(processor: str, options: dict) -> str | None:
    """Returns an error message if options are invalid for this processor, else None."""
    spec = PROCESSORS.get(processor)
    if not spec:
        return f"unknown processor {processor}"

    if spec["kind"] == "model-scale":
        model = str(options.get("model", spec["default_model"]))
        model_spec = spec["models"].get(model)
        if not model_spec:
            return f"unknown {processor} model {model!r}"
        scale = int(options.get("scaling_factor", model_spec["scales"][0]))
        if scale not in model_spec["scales"]:
            return f"{processor} model {model!r} only supports scale {model_spec['scales']}, got {scale}"

    elif spec["kind"] == "model-scale-noise":
        model = str(options.get("model", spec["default_model"]))
        model_spec = spec["models"].get(model)
        if not model_spec:
            return f"unknown {processor} model {model!r}"
        scale = str(options.get("scaling_factor", next(iter(model_spec["scales"]))))
        noise_options = model_spec["scales"].get(scale)
        if noise_options is None:
            return f"{processor} model {model!r} only supports scale {list(model_spec['scales'])}, got {scale}"
        noise = int(options.get("noise_level", noise_options[0]))
        if noise not in noise_options:
            return (
                f"{processor} model {model!r} scale {scale} only supports "
                f"noise level {noise_options}, got {noise}"
            )

    return None
