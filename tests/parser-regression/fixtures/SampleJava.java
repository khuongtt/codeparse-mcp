package com.example;

import java.util.List;

/**
 * Sample Java class for parser regression testing.
 * Covers: if/else, for, while, do, switch, ternary, compound conditions.
 */
public class SampleJava {

    public String classify(int value) {
        if (value > 0) {
            return "positive";
        } else if (value == 0) {
            return "zero";
        } else {
            return "negative";
        }
    }

    public int sumEven(List<Integer> items) {
        int total = 0;
        for (int i = 0; i < items.size(); i++) {
            if (items.get(i) % 2 == 0) {
                total += items.get(i);
            }
        }
        return total;
    }

    public boolean isInRange(int x, int min, int max) {
        return (x >= min && x <= max) ? true : false;
    }

    public int factorial(int n) {
        int result = 1;
        int i = 1;
        while (i <= n) {
            result *= i;
            i++;
        }
        return result;
    }

    public String grade(int score) {
        if (score >= 90 && score <= 100) {
            return "A";
        } else if (score >= 80 && score < 90) {
            return "B";
        } else if (score >= 70 && score < 80) {
            return "C";
        } else if (score >= 60 && score < 70) {
            return "D";
        } else {
            return "F";
        }
    }

    public int sign(int x) {
        return (x > 0) ? 1 : (x < 0) ? -1 : 0;
    }

    public String getDayName(int day) {
        switch (day) {
            case 1: return "Monday";
            case 2: return "Tuesday";
            case 3: return "Wednesday";
            case 4: return "Thursday";
            case 5: return "Friday";
            default: return "Weekend";
        }
    }
}
