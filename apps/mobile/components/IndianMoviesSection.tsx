import React, { useState, useCallback, useMemo, useEffect } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ScrollView,
  useWindowDimensions,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Movie } from "@filmsnaps/shared";
import { colors } from "../theme/colors";
import { MediaCard } from "./MediaCard";
import { Shimmer } from "./Shimmer";
import { useLatestIndianMovies } from "../hooks/useTMDB";
import { useSwipeTabNavigator } from "./SwipeTabNavigator";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { warmSwatches } from "../lib/movieAccent";

const ITEM_GAP = 10;
const ITEM_PADDING = 16;
const SKELETON_ITEMS = 4;

interface IndianLanguageOption {
  id: string;
  label: string;
  code?: string;
}

const INDIAN_LANGUAGES: IndianLanguageOption[] = [
  { id: "all", label: "All" },
  { id: "hi", label: "Hindi", code: "hi" },
  { id: "te", label: "Telugu", code: "te" },
  { id: "ta", label: "Tamil", code: "ta" },
  { id: "ml", label: "Malayalam", code: "ml" },
  { id: "kn", label: "Kannada", code: "kn" },
  { id: "pa", label: "Punjabi", code: "pa" },
  { id: "mr", label: "Marathi", code: "mr" },
  { id: "bn", label: "Bengali", code: "bn" },
];

const LANGUAGE_LABELS: Record<string, string> = {
  hi: "HINDI",
  te: "TELUGU",
  ta: "TAMIL",
  ml: "MALAYALAM",
  kn: "KANNADA",
  pa: "PUNJABI",
  mr: "MARATHI",
  bn: "BENGALI",
};

function formatDisplayDate(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) return dateStr;
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

interface IndianMoviesSectionProps {
  title?: string;
  onItemPress: (item: Movie) => void;
  onItemPressIn?: (item: Movie) => void;
}

export function IndianMoviesSection({
  title = "Latest Indian Movies",
  onItemPress,
  onItemPressIn,
}: IndianMoviesSectionProps) {
  const { width: SCREEN_WIDTH } = useWindowDimensions();
  const [selectedLang, setSelectedLang] = useState<string>("all");
  const swipeTab = useSwipeTabNavigator();

  const nativeGesture = useMemo(() => Gesture.Native(), []);

  useEffect(() => {
    if (!swipeTab) return;
    return swipeTab.registerCarousel(nativeGesture);
  }, [swipeTab, nativeGesture]);

  const { data, isLoading } = useLatestIndianMovies(selectedLang);

  const cardWidth = (SCREEN_WIDTH - 48) / 3;
  const cardHeight = cardWidth * 1.5;

  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { item: Movie }[] }) => {
      if (viewableItems.length === 0) return;
      warmSwatches(viewableItems.map(({ item }) => item));
    },
    [],
  );

  const todayStr = useMemo(() => new Date().toISOString().split("T")[0], []);

  const filteredMovies = useMemo(() => {
    if (!data?.results || !Array.isArray(data.results)) return [];
    const seen = new Set<number>();
    const list: Movie[] = [];

    for (const item of data.results) {
      if (!item || !item.id || !item.poster_path) continue;
      const relDate = item.release_date;
      if (!relDate || typeof relDate !== "string" || relDate.length < 10)
        continue;
      const cleanDate = relDate.slice(0, 10);
      if (cleanDate > todayStr) continue; // Exclude future/unreleased!

      if (!seen.has(item.id)) {
        seen.add(item.id);
        list.push({
          ...item,
          release_date: cleanDate,
        });
      }
    }
    return list.sort((a, b) => {
      const dateA = a.release_date || "";
      const dateB = b.release_date || "";
      return dateB.localeCompare(dateA);
    });
  }, [data?.results, todayStr]);

  const renderMovieItem = useCallback(
    ({ item }: { item: Movie }) => {
      const langCode = item.original_language || "";
      const langBadge = LANGUAGE_LABELS[langCode] || langCode.toUpperCase();
      const dateText = formatDisplayDate(item.release_date);

      return (
        <View style={{ width: cardWidth, marginRight: ITEM_GAP }}>
          <MediaCard
            item={item}
            onPress={onItemPress}
            onPressIn={onItemPressIn}
            badgeText={langBadge}
            subText={dateText ? `Rel: ${dateText}` : undefined}
          />
        </View>
      );
    },
    [cardWidth, onItemPress, onItemPressIn],
  );

  return (
    <View style={{ marginBottom: 24 }}>
      {/* Section Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: ITEM_PADDING,
          marginBottom: 10,
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

      {/* Language Filter Chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: ITEM_PADDING,
          marginBottom: 12,
          gap: 8,
        }}
      >
        {INDIAN_LANGUAGES.map((lang) => {
          const isSelected = selectedLang === lang.id;
          return (
            <TouchableOpacity
              key={lang.id}
              onPress={() => setSelectedLang(lang.id)}
              activeOpacity={0.7}
              style={[
                styles.chip,
                isSelected ? styles.chipActive : styles.chipInactive,
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  isSelected ? styles.chipTextActive : styles.chipTextInactive,
                ]}
              >
                {lang.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Movie List or Loading Shimmer */}
      {isLoading ? (
        <View
          style={{
            flexDirection: "row",
            paddingHorizontal: ITEM_PADDING,
            gap: ITEM_GAP,
          }}
        >
          {Array.from({ length: SKELETON_ITEMS }).map((_, i) => (
            <Shimmer
              key={i}
              width={cardWidth}
              height={cardHeight}
              borderRadius={12}
            />
          ))}
        </View>
      ) : filteredMovies.length > 0 ? (
        <GestureDetector gesture={nativeGesture}>
          <FlatList
            data={filteredMovies}
            keyExtractor={(item) => `indian-${selectedLang}-${item.id}`}
            renderItem={renderMovieItem}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: ITEM_PADDING }}
            onViewableItemsChanged={handleViewableItemsChanged}
            viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
          />
        </GestureDetector>
      ) : (
        <View
          style={{
            paddingHorizontal: ITEM_PADDING,
            paddingVertical: 18,
            alignItems: "center",
          }}
        >
          <Text style={{ color: colors.textTertiary, fontSize: 13 }}>
            No recent releases found for this language.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  chipActive: {
    backgroundColor: colors.gold,
    borderColor: colors.gold,
  },
  chipInactive: {
    backgroundColor: colors.bgElevated,
    borderColor: colors.borderSubtle,
  },
  chipText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  chipTextActive: {
    color: "#080808",
    fontFamily: "Inter_600SemiBold",
  },
  chipTextInactive: {
    color: colors.textSecondary,
  },
});
