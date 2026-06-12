import { RewardedAd, RewardedAdEventType, TestIds } from 'react-native-google-mobile-ads';
import { Platform } from 'react-native';

const REWARDED_AD_UNIT_ID_REAL = {
  android: 'ca-app-pub-4718826806092770/4752834073',
  ios:     'ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX', // TODO: reemplazar con el real unit ID de iOS antes de publicar en App Store
};

const REWARDED_UNIT_ID = __DEV__
  ? TestIds.REWARDED
  : Platform.select(REWARDED_AD_UNIT_ID_REAL);

// Rejects with { userClosed: true } when user closes without reward.
// Rejects with { loadError: true, message } when the ad fails to load.
export function showRewardedAd() {
  return new Promise((resolve, reject) => {
    const ad = RewardedAd.createForAdRequest(REWARDED_UNIT_ID, {
      requestNonPersonalizedAdsOnly: false,
    });

    let earned = false;
    let settled = false;

    function settle(fn) {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    }

    const unsubscribeLoaded = ad.addAdEventListener(RewardedAdEventType.LOADED, () => {
      ad.show();
    });

    const unsubscribeEarned = ad.addAdEventListener(RewardedAdEventType.EARNED_REWARD, (reward) => {
      earned = true;
      settle(() => resolve(reward));
    });

    const unsubscribeError = ad.addAdEventListener('error', (error) => {
      const msg = error?.message || String(error);
      settle(() => reject({ loadError: true, message: msg }));
    });

    const unsubscribeClosed = ad.addAdEventListener('closed', () => {
      if (!earned) settle(() => reject({ userClosed: true }));
    });

    function cleanup() {
      unsubscribeLoaded();
      unsubscribeEarned();
      unsubscribeError();
      unsubscribeClosed();
    }

    ad.load();
  });
}
