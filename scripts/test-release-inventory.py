import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('verify-release-inventory.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.artifacts = {}
        for name in ('hub', 'cli', 'rollbackHub', 'rollbackCli'):
            path = self.root / name
            path.write_text(name)
            self.artifacts[name] = {'path': str(path), 'sha256': hashlib.sha256(name.encode()).hexdigest()}
        self.doc = {'schema': 'hapi-release-inventory/v1', 'sourceCommit': 'a' * 40,
                    'checks': {name: 'passed' for name in guard.REQUIRED_CHECKS}, 'artifacts': self.artifacts}
    def verify(self):
        path = self.root / 'release.json'
        path.write_text(json.dumps(self.doc))
        return guard.verify(path)
    def test_complete_release(self):
        self.assertEqual(set(self.verify()), set(self.artifacts))
    def test_every_existing_patch_is_required(self):
        for name in guard.REQUIRED_CHECKS:
            with self.subTest(name=name):
                self.doc['checks'][name] = 'not-run'
                with self.assertRaises(ValueError): self.verify()
                self.doc['checks'][name] = 'passed'
    def test_missing_check(self):
        del self.doc['checks']['ios15-gfm']
        with self.assertRaises(ValueError): self.verify()
    def test_drift_in_either_installed_binary(self):
        for name in ('hub', 'cli'):
            Path(self.artifacts[name]['path']).write_text('unreviewed replacement')
            with self.assertRaises(ValueError): self.verify()
            Path(self.artifacts[name]['path']).write_text(name)
    def test_missing_rollback(self):
        Path(self.artifacts['rollbackHub']['path']).unlink()
        with self.assertRaises(OSError): self.verify()
    def test_unpinned_source(self):
        self.doc['sourceCommit'] = 'main'
        with self.assertRaises(ValueError): self.verify()
    def test_relative_artifact_path(self):
        self.artifacts['hub']['path'] = 'hub'
        with self.assertRaises(ValueError): self.verify()
    def test_invalid_schema(self):
        self.doc['schema'] = 'unknown'
        with self.assertRaises(ValueError): self.verify()
    def test_missing_component(self):
        del self.artifacts['cli']
        with self.assertRaises(ValueError): self.verify()

if __name__ == '__main__': unittest.main()
