from pydantic import BaseModel, Field
from typing import Annotated, Literal, Optional

VALID_GROK_ASPECT_RATIOS = Literal["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2"]
VALID_GROK_IMAGE_RESOLUTIONS = Literal["1k", "2k"]
VALID_GROK_VIDEO_RESOLUTIONS = Literal["480p", "720p"]

VALID_NOISE_SCHEDULES = Literal["karras", "exponential", "polyexponential"]

VALID_MODELS = Literal[
    "nai-diffusion-4-5-full",
]

VALID_SAMPLERS = Literal[
    "k_euler",
    "k_euler_ancestral",
    "k_dpmpp_2s_ancestral",
    "k_dpmpp_2m",
    "k_dpmpp_2m_sde",
    "k_dpmpp_sde",
]


class VibeImage(BaseModel):
    image: str  # base64
    information_extracted: float = Field(default=1.0, ge=0, le=1)
    strength: float = Field(default=0.6, ge=0, le=1)


class CharCenter(BaseModel):
    x: float = Field(default=0.5, ge=0.0, le=1.0)
    y: float = Field(default=0.5, ge=0.0, le=1.0)


class CharCaption(BaseModel):
    char_caption: str
    centers: list[CharCenter] = Field(default_factory=lambda: [CharCenter()])


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1)
    negative_prompt: str = ""
    model: VALID_MODELS = "nai-diffusion-4-5-full"
    width: int = Field(default=832, ge=64, le=2048)
    height: int = Field(default=1216, ge=64, le=2048)
    steps: int = Field(default=23, ge=1, le=50)
    scale: float = Field(default=5.0, ge=0, le=10)
    sampler: VALID_SAMPLERS = "k_euler_ancestral"
    seed: int = Field(default=0, ge=0)
    sm: bool = False
    sm_dyn: bool = False
    noise_schedule: VALID_NOISE_SCHEDULES = "karras"
    cfg_rescale: float = Field(default=0.0, ge=0, le=1)
    # img2img
    image: Optional[str] = None  # base64
    strength: float = Field(default=0.7, ge=0, le=1)
    noise: float = Field(default=0.0, ge=0, le=1)
    # vibe transfer
    reference_images: list[VibeImage] = Field(default_factory=list)
    # multi-character composer
    char_captions: list[CharCaption] = Field(default_factory=list)  # per-character prompts with positions
    use_coords: Optional[bool] = None  # explicit coordinate control; None = auto-detect from centers


class GenerateResponse(BaseModel):
    image: str  # base64 encoded png
    seed: int


class CharacterUsage(BaseModel):
    tag: str
    count: int = Field(ge=1)


class CharacterUsageList(BaseModel):
    characters: list[CharacterUsage]


class RecordCharactersRequest(BaseModel):
    tags: list[Annotated[str, Field(min_length=1)]] = Field(default_factory=list)


class GalleryFileItem(BaseModel):
    name: str
    size: int
    meta: dict = Field(default_factory=dict)


class GalleryListResponse(BaseModel):
    path: str
    directories: list[str]
    files: list[GalleryFileItem]


class StoryCreateRequest(BaseModel):
    title: str = "Untitled Story"
    content: str = ""


class StoryUpdateRequest(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None


class StoryRecord(BaseModel):
    id: str
    title: str
    content: str
    created_at: str  # ISO 8601
    updated_at: str


class StoryListItem(BaseModel):
    id: str
    title: str
    word_count: int
    created_at: str
    updated_at: str


# ---------------------------------------------------------------------------
# Prompt DNA — tag suggestion
# ---------------------------------------------------------------------------

class SuggestTagsRequest(BaseModel):
    tags: list[Annotated[str, Field(min_length=1)]] = Field(default_factory=list)


class TagSuggestion(BaseModel):
    name: str
    score: float = Field(ge=0.0, le=1.0)
    category: str
    count: int = Field(ge=0)


class SuggestTagsResponse(BaseModel):
    boosters: list[TagSuggestion]
    contrasts: list[TagSuggestion]
    wildcards: list[TagSuggestion]


# ---------------------------------------------------------------------------
# Prompt Autopsy — image analysis
# ---------------------------------------------------------------------------

class AnalyzeImageRequest(BaseModel):
    image: str  # base64 encoded image


class AnalyzedTag(BaseModel):
    name: str
    score: float = Field(ge=0.0, le=1.0)
    category: str


class AnalyzeImageResponse(BaseModel):
    status: Literal["complete", "downloading"]
    tags: list[AnalyzedTag] = Field(default_factory=list)
    progress: Optional[int] = None  # set when status == "downloading"


# ---------------------------------------------------------------------------
# Grok (xAI) — image and video generation
# ---------------------------------------------------------------------------

class GrokImageRequest(BaseModel):
    prompt: str = Field(min_length=1)
    aspect_ratio: VALID_GROK_ASPECT_RATIOS = "1:1"
    resolution: VALID_GROK_IMAGE_RESOLUTIONS = "1k"
    image: Optional[str] = None  # base64 source image for editing


class GrokVideoRequest(BaseModel):
    prompt: str = Field(min_length=1)
    aspect_ratio: VALID_GROK_ASPECT_RATIOS = "1:1"
    resolution: VALID_GROK_VIDEO_RESOLUTIONS = "720p"
    duration: int = Field(default=5, ge=1, le=15)


class GrokImageResponse(BaseModel):
    image: str  # base64


class GrokVideoResponse(BaseModel):
    video: str  # base64 MP4


# ---------------------------------------------------------------------------
# Image Explorer — web page proxy and image extraction
# ---------------------------------------------------------------------------

class ExplorePageRequest(BaseModel):
    url: str = Field(min_length=1)


class ExploreImage(BaseModel):
    src: str
    alt: str = ""
    width: Optional[int] = None
    height: Optional[int] = None


class ExploreLink(BaseModel):
    href: str
    text: str = ""


class ExplorePageResponse(BaseModel):
    url: str
    title: str = ""
    images: list[ExploreImage]
    links: list[ExploreLink]

