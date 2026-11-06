"""Choose real AI scaling passes without enlarging frames before inference."""
import math
from fractions import Fraction


def super_resolution_plan(source_width, source_height, width, height, strategy):
    if min(source_width, source_height, width, height) < 1:
        raise ValueError('视频尺寸无效')
    if strategy not in ('speed', 'quality'):
        raise ValueError('处理策略无效')
    ratio = max(Fraction(width, source_width), Fraction(height, source_height))
    required = max(Fraction(2), ratio)
    # Available model factors are 2, 3 and 4. Combine them for >4x requests;
    # choose the least sufficient total scale, then fewer passes/smaller early passes.
    candidates = []
    for twos in range(math.ceil(math.log2(float(required))) + 2):
        for threes in range(math.ceil(math.log(float(required), 3)) + 2):
            factor = 2 ** twos * 3 ** threes
            if factor < required:
                continue
            scales = sorted([4] * (twos // 2) + [2] * (twos % 2) + [3] * threes)
            pixels, current = 0, 1
            for scale in scales:
                current *= scale
                pixels += current * current
            candidates.append((factor, len(scales), pixels, scales))
    factor, _, _, scales = min(candidates)
    pre_factor = min(Fraction(1), ratio / factor) if strategy == 'speed' else Fraction(1)
    input_width = min(source_width, max(1, math.ceil(source_width * pre_factor)))
    input_height = min(source_height, max(1, math.ceil(source_height * pre_factor)))
    return {
        'strategy': strategy, 'inputWidth': input_width, 'inputHeight': input_height,
        'scales': scales, 'aiWidth': input_width * factor, 'aiHeight': input_height * factor,
        'outputWidth': width, 'outputHeight': height,
        'preResize': (input_width, input_height) != (source_width, source_height),
        'postResize': (input_width * factor, input_height * factor) != (width, height),
    }
