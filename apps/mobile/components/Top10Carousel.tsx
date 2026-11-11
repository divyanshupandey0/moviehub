import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  useWindowDimensions,
  Animated,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { getImageUrl } from "@filmsnaps/shared";
import type { Movie } from "@filmsnaps/shared";
import { colors } from "../theme/colors";
import { ProgressiveImage } from "./ProgressiveImage";
import { useSwipeTabNavigator } from "./SwipeTabNavigator";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { warmSwatches } from "../lib/movieAccent";

const ITEM_GAP = 14;
const ITEM_PADDING = 16;

interface Top10CarouselProps {
  title?: string;
  data: Movie[];
  onItemPress: (item: Movie) => void;
  onItemPressIn?: (item: Movie) => void;
}

const Top10Card = React.memo(function Top10Card({
  item,
  rank,
  cardWidth,
  cardHeight,
  onPress,
  onPressIn,
}: {
  item: Movie;
  rank: number;
  cardWidth: number;
  cardHeight: number;
  onPress: (item: Movie) => void;
  onPressIn?: (item: Movie) => void;
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const posterUrl = getImageUrl(item.poster_path, "w342");

  const handlePressIn = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 0.96,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  }, [scaleAnim]);

  const handlePressOut = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      speed: 50,
      bounciness: 4,
    }).start();
  }, [scaleAnim]);

  const title = item.title || item.name || "Untitled";

  return (
    <TouchableOpacity
      onPress={() => onPress(item)}
      onPressIn={() => {
        onPressIn?.(item);
        handlePressIn();
      }}
      onPressOut={handlePressOut}
      activeOpacity={1}
      style={{
        width: cardWidth + 24,
        marginRight: ITEM_GAP,
        marginBottom: 14,
      }}
      accessibilityRole="button"
      accessibilityLabel={`Rank ${rank}: ${title}${item.vote_average ? `, rated ${item.vote_average.toFixed(1)} out of 10` : ""}`}
    >
      <Animated.View
        style={{
          transform: [{ scale: scaleAnim }],
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
          {/* Prominent Rank Number */}
          <View
            style={{
              width: 32,
              height: cardHeight,
              justifyContent: "flex-end",
              alignItems: "center",
              paddingBottom: 4,
              marginRight: -6,
              zIndex: 2,
            }}
          >
            <Text
              style={styles.rankNumberText}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {rank}
            </Text>
          </View>

          {/* Poster Container */}
          <View
            style={{
              width: cardWidth,
              height: cardHeight,
              borderRadius: 12,
              overflow: "hidden",
              backgroundColor: colors.bgElevated,
              borderWidth: 0.5,
              borderColor: colors.borderSubtle,
            }}
          >
            {item.poster_path ? (
              <ProgressiveImage
                uri={posterUrl}
                style={{ width: cardWidth, height: cardHeight }}
                resizeMode="cover"
              />
            ) : (
              <View
                style={{
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.bgElevated,
                  paddingHorizontal: 8,
                }}
              >
                <Ionicons
                  name="film-outline"
                  size={28}
                  color={colors.textTertiary}
                  style={{ marginBottom: 4 }}
                />
                <Text
                  style={{
                    color: colors.textTertiary,
                    fontSize: 11,
                    textAlign: "center",
                  }}
                  numberOfLines={3}
                >
                  {title}
                </Text>
              </View>
            )}

            {/* Top 10 badge */}
            <View style={styles.topBadge}>
              <Text style={styles.topBadgeText}>TOP 10</Text>
            </View>
          </View>
        </View>

        {/* Title row with rating */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 6,
            paddingLeft: 28,
            width: cardWidth + 24,
          }}
        >
          <Text
            style={{
              color: colors.textSecondary,
              fontSize: 12,
              fontFamily: "Inter_500Medium",
              flex: 1,
              marginRight: 4,
            }}
            numberOfLines={1}
          >
            {title}
          </Text>
          {item.vote_average != null && item.vote_average > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Ionicons
                name="star"
                size={10}
                color={colors.gold}
                style={{ marginRight: 2 }}
              />
              <Text
                style={{
                  color: colors.gold,
                  fontSize: 10,
                  fontFamily: "Inter_600SemiBold",
                }}
              >
                {item.vote_average.toFixed(1)}
              </Text>
            </View>
          )}
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
});

export function Top10Carousel({
  title = "Top 10 Movies – Global Today",
  data,
  onItemPress,
  onItemPressIn,
}: Top10CarouselProps) {
  const { width: SCREEN_WIDTH } = useWindowDimensions();
  const swipeTab = useSwipeTabNavigator();

  const nativeGesture = useMemo(() => Gesture.Native(), []);

  useEffect(() => {
    if (!swipeTab) return;
    return swipeTab.registerCarousel(nativeGesture);
  }, [swipeTab, nativeGesture]);

  const cardWidth = (SCREEN_WIDTH - 48) / 3;
  const cardHeight = cardWidth * 1.5;

  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { item: Movie }[] }) => {
      if (viewableItems.length === 0) return;
      warmSwatches(viewableItems.map(({ item }) => item));
    },
    [],
  );

  const top10List = useMemo(() => {
    const list: Movie[] = [];
    const seen = new Set<number>();
    for (const item of data) {
      if (item && item.id && !seen.has(item.id)) {
        seen.add(item.id);
        list.push(item);
      }
      if (list.length === 10) break;
    }
    return list;
  }, [data]);

  const renderItem = useCallback(
    ({ item, index }: { item: Movie; index: number }) => (
      <Top10Card
        item={item}
        rank={index + 1}
        cardWidth={cardWidth}
        cardHeight={cardHeight}
        onPress={onItemPress}
        onPressIn={onItemPressIn}
      />
    ),
    [cardWidth, cardHeight, onItemPress, onItemPressIn],
  );

  if (top10List.length === 0) return null;

  return (
    <View style={{ marginBottom: 24 }}>
      {/* Section Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: ITEM_PADDING,
          marginBottom: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View
            style={{
              width: 3,
              height: 16,
              borderRadius: 2,
              backgroundColor: colors.gold,
              marginRight: 8,
            }}
          />
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: 18,
              fontFamily: "PlayfairDisplay_700Bold",
              letterSpacing: 0.3,
            }}
          >
            {title}
          </Text>
        </View>
      </View>

      <GestureDetector gesture={nativeGesture}>
        <FlatList
          data={top10List}
          keyExtractor={(item) => `top10-${item.id}`}
          renderItem={renderItem}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: ITEM_PADDING }}
          onViewableItemsChanged={handleViewableItemsChanged}
          viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
        />
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  rankNumberText: {
    color: colors.gold,
    fontSize: 54,
    fontFamily: "Inter_700Bold",
    fontWeight: "900",
    textShadowColor: "rgba(0, 0, 0, 0.95)",
    textShadowOffset: { width: 1, height: 2 },
    textShadowRadius: 6,
    lineHeight: 58,
  },
  topBadge: {
    position: "absolute",
    top: 6,
    left: 6,
    backgroundColor: "rgba(229, 185, 75, 0.95)",
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
  },
  topBadgeText: {
    color: "#080808",
    fontSize: 8,
    fontFamily: "Inter_700Bold",
    fontWeight: "800",
    letterSpacing: 0.5,
  },
});
