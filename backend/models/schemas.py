from pydantic import BaseModel, Field
from typing import Annotated, Literal, Optional

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
    steps: int = Field(default=28, ge=1, le=50)
    scale: float = Field(default=5.0, ge=0, le=10)
    sampler: VALID_SAMPLERS = "k_euler_ancestral"
    seed: int = Field(default=0, ge=0)
    sm: bool = False
    sm_dyn: bool = False
    # img2img
    image: Optional[str] = None  # base64
    strength: float = Field(default=0.7, ge=0, le=1)
    noise: float = Field(default=0.0, ge=0, le=1)
    # vibe transfer
    reference_image: Optional[str] = None  # base64
    reference_information_extracted: float = Field(default=1.0, ge=0, le=1)
    reference_strength: float = Field(default=0.6, ge=0, le=1)
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


