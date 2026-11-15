import sys
from typing import Any, Dict, get_type_hints

try:
    from pydantic import BaseModel as _PydanticBaseModel, Field as _PydanticField
    HAS_PYDANTIC = True
except ImportError:
    HAS_PYDANTIC = False

if HAS_PYDANTIC:
    BaseModel = _PydanticBaseModel
    Field = _PydanticField
else:
    def Field(default=..., **kwargs):
        return default

    class BaseModel:
        def __init__(self, **data: Any):
            # Assign attributes from type hints and defaults
            for key, val in data.items():
                setattr(self, key, val)

            # Set default class attributes if not in data
            for key in dir(self.__class__):
                if not key.startswith('_') and key not in data:
                    val = getattr(self.__class__, key)
                    if not callable(val):
                        setattr(self, key, val)

        def dict(self) -> Dict[str, Any]:
            res = {}
            for k, v in self.__dict__.items():
                if not k.startswith('_'):
                    if isinstance(v, BaseModel):
                        res[k] = v.dict()
                    elif isinstance(v, list):
                        res[k] = [item.dict() if isinstance(item, BaseModel) else item for item in v]
                    else:
                        res[k] = v
            return res

        def model_dump(self) -> Dict[str, Any]:
            return self.dict()

        def __repr__(self):
            attrs = ", ".join(f"{k}={v!r}" for k, v in self.__dict__.items() if not k.startswith('_'))
            return f"{self.__class__.__name__}({attrs})"
