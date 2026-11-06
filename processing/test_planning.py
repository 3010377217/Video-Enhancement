import unittest
from planning import super_resolution_plan
from encoding import rate_budget
from worker import filters


class ProcessingPlanTests(unittest.TestCase):
    def test_720_to_1080_speed_uses_ai_for_final_enlargement(self):
        plan = super_resolution_plan(1280, 720, 1920, 1080, 'speed')
        self.assertEqual((plan['inputWidth'], plan['inputHeight']), (960, 540))
        self.assertEqual(plan['scales'], [2])
        self.assertEqual((plan['aiWidth'], plan['aiHeight']), (1920, 1080))
        self.assertFalse(plan['postResize'])

    def test_quality_keeps_native_input_details(self):
        plan = super_resolution_plan(1280, 720, 1920, 1080, 'quality')
        self.assertEqual((plan['inputWidth'], plan['inputHeight']), (1280, 720))
        self.assertEqual((plan['aiWidth'], plan['aiHeight']), (2560, 1440))

    def test_720_to_4k_uses_native_3x_model(self):
        plan = super_resolution_plan(1280, 720, 3840, 2160, 'speed')
        self.assertEqual(plan['scales'], [3])
        self.assertFalse(plan['preResize'])
        self.assertFalse(plan['postResize'])

    def test_odd_portrait_downscale_and_extreme_targets_never_pre_enlarge(self):
        sources = [(1280, 720), (854, 480), (161, 121), (720, 1280), (16, 16)]
        targets = [(1920, 1080), (1080, 1920), (1280, 720), (320, 180), (7680, 4320)]
        for source in sources:
            for target in targets:
                for strategy in ('speed', 'quality'):
                    with self.subTest(source=source, target=target, strategy=strategy):
                        plan = super_resolution_plan(*source, *target, strategy)
                        self.assertLessEqual(plan['inputWidth'], source[0])
                        self.assertLessEqual(plan['inputHeight'], source[1])
                        self.assertGreaterEqual(plan['aiWidth'], target[0])
                        self.assertGreaterEqual(plan['aiHeight'], target[1])
                        self.assertTrue(all(scale in (2, 3, 4) for scale in plan['scales']))

    def test_unusable_audio_budget_fails_before_processing(self):
        with self.assertRaisesRegex(RuntimeError, '体积预算过低'):
            rate_budget({'source': {'duration': 60, 'audio': True},
                         'config': {'audio': True, 'rateControl': 'size', 'sizeLimit': '0.1', 'bitrate': '1'}})

    def test_ratio_fit_does_not_lose_two_pixels_to_float_rounding(self):
        width, height, _ = filters({'source': {'width': 854, 'height': 480},
                                    'config': {'resolution': '1080p', 'keepRatio': True}})
        self.assertEqual((width, height), (1920, 1078))


if __name__ == '__main__':
    unittest.main()
