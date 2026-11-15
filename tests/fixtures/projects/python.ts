/** Small broken Python projects used by pipeline tests. Each entry documents the expected outcome. */
export const PY_FIXTURES = {
  /** requests==2.0.99 never existed. Expect missing-version -> python-repin-version -> requirements.txt only. */
  dependencyFailure: {
    files: {
      'requirements.txt': 'requests==2.0.99\nflask==2.0.1\n',
      'src/app.py': 'import requests\n\n\ndef get(url):\n    return requests.get(url)\n',
      'tests/test_app.py': 'from src.app import get\n\n\ndef test_get():\n    assert callable(get)\n',
    } as Record<string, string>,
    commitDate: '2021-06-01T00:00:00Z',
  },
  /** collections.Mapping was removed in 3.10. Expect removed-stdlib-api -> python-pin-runtime -> .python-version only. */
  runtimeMismatch: {
    files: {
      'requirements.txt': 'six==1.16.0\npytest\n',
      'setup.py': "from setuptools import setup\nsetup(name='legacy', version='1.0', py_modules=['legacy'])\n",
      'legacy.py': 'from collections import Mapping\n\n\ndef is_map(x):\n    return isinstance(x, Mapping)\n',
      'test_legacy.py': 'from legacy import is_map\n\n\ndef test_map():\n    assert is_map({})\n',
    } as Record<string, string>,
    commitDate: '2019-06-01T00:00:00Z',
  },
  /** Poetry lock out of date. Expect lockfile-drift -> python-regenerate-lock -> poetry.lock only. */
  lockfileInconsistency: {
    files: {
      'pyproject.toml':
        '[tool.poetry]\nname = "lockdemo"\nversion = "0.1.0"\ndescription = ""\nauthors = []\n\n[tool.poetry.dependencies]\npython = "^3.9"\nrequests = "^2.25"\nclick = "^8.0"\n\n[build-system]\nrequires = ["poetry-core"]\nbuild-backend = "poetry.core.masonry.api"\n',
      'poetry.lock': '# stale lock\n[metadata]\ncontent-hash = "old"\n',
      'lockdemo/__init__.py': 'VALUE = 1\n',
    } as Record<string, string>,
    commitDate: '2022-01-01T00:00:00Z',
  },
  /** Project with no tests: must never be reported as functionally tested. */
  noTests: {
    files: {
      'requirements.txt': 'six==1.16.0\n',
      'main.py': 'print("hi")\n',
    } as Record<string, string>,
    commitDate: '2022-01-01T00:00:00Z',
  },
};
