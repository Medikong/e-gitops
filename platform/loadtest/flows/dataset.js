import { fail } from 'k6';

import { setupReadApiBasicDataset } from './datasets/read-api-basic.js';
import { setupReservationJourneyDataset } from './datasets/reservation-journey.js';

// 데이터셋 준비는 의도적으로 profile 기반으로 둔다. 조회 부하테스트는 시간이
// 지나면서 넓은 공연 목록, 큰 좌석 맵, 많은 공연 회차, 매진에 가까운 재고,
// 상태 edge case 조합처럼 서로 다른 데이터 모양이 필요해질 수 있다.
// scenario entrypoint는 고정하고, 새 데이터 모양은 작은 profile 모듈로 추가한다.
//
// 예시:
//   import { setupLargeSeatMapDataset } from './datasets/large-seat-map.js';
//   datasetProfiles['large-seat-map'] = setupLargeSeatMapDataset;
const datasetProfiles = {
  'read-api-basic': setupReadApiBasicDataset,
  'reservation-create': setupReadApiBasicDataset,
  'reservation-seat-contention': setupReadApiBasicDataset,
  'reservation-journey': setupReservationJourneyDataset,
};

export function supportedDatasetProfiles() {
  return Object.keys(datasetProfiles).sort();
}

export function setupDatasetProfile(config, tokens) {
  // 이 dispatcher가 fake dataset 준비의 확장 경계다. k6 scenario, Helm values,
  // GitOps manualRuns는 유지하고, LOADTEST_DATASET_PROFILE만 바꿔
  // 실제 데이터셋 생성 방식을 선택한다.
  const setup = datasetProfiles[config.dataset.profile];
  if (!setup) {
    fail(`unsupported LOADTEST_DATASET_PROFILE=${config.dataset.profile}; supported profiles: ${supportedDatasetProfiles().join(', ')}`);
  }
  return setup(config, tokens);
}
